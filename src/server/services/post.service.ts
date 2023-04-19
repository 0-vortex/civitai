import { GetByIdInput } from '~/server/schema/base.schema';
import { SessionUser } from 'next-auth';
import { isNotImageResource } from './../schema/image.schema';
import { editPostSelect } from './../selectors/post.selector';
import { isDefined } from '~/utils/type-guards';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import {
  PostUpdateInput,
  AddPostTagInput,
  AddPostImageInput,
  UpdatePostImageInput,
  PostCreateInput,
  ReorderPostImagesInput,
  RemovePostTagInput,
  GetPostTagsInput,
  PostsQueryInput,
  GetPostsByCategoryInput,
} from './../schema/post.schema';
import { dbWrite, dbRead } from '~/server/db/client';
import { TagType, TagTarget, Prisma, ImageGenerationProcess } from '@prisma/client';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { editPostImageSelect } from '~/server/selectors/post.selector';
import { constants, ModelFileType } from '~/server/common/constants';
import { isImageResource } from '~/server/schema/image.schema';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { BrowsingMode, PostSort } from '~/server/common/enums';
import { getImageV2Select } from '~/server/selectors/imagev2.selector';
import uniqWith from 'lodash/uniqWith';
import isEqual from 'lodash/isEqual';
import {
  applyModRulesSql,
  applyUserPreferencesSql,
  getImagesForPosts,
  userPreferencesToSql,
} from '~/server/services/image.service';
import { redis } from '~/server/redis/client';
import { indexOfOr } from '~/utils/array-helpers';
import { hashifyObject } from '~/utils/string-helpers';

export type PostsInfiniteModel = AsyncReturnType<typeof getPostsInfinite>['items'][0];
export const getPostsInfinite = async ({
  limit,
  cursor,
  query,
  username,
  excludedTagIds,
  excludedUserIds,
  excludedImageIds,
  period,
  sort,
  user,
  tags,
  modelVersionId,
}: PostsQueryInput & { user?: SessionUser }) => {
  const AND: Prisma.Enumerable<Prisma.PostWhereInput> = [];
  const orderBy: Prisma.Enumerable<Prisma.PostOrderByWithRelationInput> = [];
  const isOwnerRequest = user && user.username === username;
  if (username) {
    const targetUser = await dbRead.user.findFirst({ where: { username }, select: { id: true } });
    AND.push({ userId: targetUser?.id });
  }
  if (modelVersionId) AND.push({ modelVersionId });
  if (isOwnerRequest) {
    orderBy.push({ id: 'desc' });
  } else {
    AND.push({ publishedAt: { not: null } });
    if (query) AND.push({ title: { in: query } });
    if (!!excludedTagIds?.length) {
      AND.push({
        OR: [
          { userId: user?.id },
          {
            tags: { none: { tagId: { in: excludedTagIds } } },
            helper: { scanned: true },
          },
        ],
      });
    }
    if (!!tags?.length) AND.push({ tags: { some: { tagId: { in: tags } } } });
    if (!!excludedUserIds?.length) AND.push({ user: { id: { notIn: excludedUserIds } } });

    // sorting
    if (sort === PostSort.MostComments)
      orderBy.push({ rank: { [`commentCount${period}Rank`]: 'asc' } });
    else if (sort === PostSort.MostReactions)
      orderBy.push({ rank: { [`reactionCount${period}Rank`]: 'asc' } });
    orderBy.push({ publishedAt: 'desc' });
  }

  const posts = await dbRead.post.findMany({
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    where: { AND },
    orderBy,
    select: {
      id: true,
      nsfw: true,
      title: true,
      // user: { select: userWithCosmeticsSelect },
      publishedAt: true,
    },
  });

  const images = posts.length
    ? await getImagesForPosts({
        postIds: posts.map((x) => x.id),
        excludedTagIds,
        excludedUserIds,
        excludedIds: excludedImageIds,
        userId: user?.id,
      })
    : [];

  let nextCursor: number | undefined;
  if (posts.length > limit) {
    const nextItem = posts.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    items: posts
      .map((post) => ({
        ...post,
        image: images.find((x) => x.postId === post.id) as (typeof images)[0],
      }))
      .filter((x) => x.image !== undefined),
  };
};

export const getPostDetail = async ({ id, user }: GetByIdInput & { user?: SessionUser }) => {
  const post = await dbRead.post.findUnique({
    where: { id },
    select: {
      id: true,
      nsfw: true,
      title: true,
      detail: true,
      modelVersionId: true,
      user: { select: userWithCosmeticsSelect },
      publishedAt: true,
      tags: { select: { tag: { select: simpleTagSelect } } },
    },
  });
  if (!post) throw throwNotFoundError();
  return {
    ...post,
    tags: post.tags.flatMap((x) => x.tag),
  };
};

export const getPostEditDetail = async ({ id }: GetByIdInput) => {
  const post = await dbWrite.post.findUnique({
    where: { id },
    select: editPostSelect,
  });
  if (!post) throw throwNotFoundError();
  return {
    ...post,
    tags: post.tags.flatMap((x) => x.tag),
    images: post.images,
  };
};

export const createPost = async ({ userId, ...data }: PostCreateInput & { userId: number }) => {
  const result = await dbWrite.post.create({
    data: { ...data, userId },
    select: editPostSelect,
  });
  return {
    ...result,
    tags: result.tags.flatMap((x) => x.tag),
    images: result.images,
  };
};

export const updatePost = ({ id, ...data }: PostUpdateInput) => {
  return dbWrite.post.update({
    where: { id },
    data: {
      ...data,
      title: data.title !== undefined ? (data.title.length > 0 ? data.title : null) : undefined,
      detail: data.detail !== undefined ? (data.detail.length > 0 ? data.detail : null) : undefined,
    },
  });
};

export const deletePost = async ({ id }: GetByIdInput) => {
  await dbWrite.post.delete({ where: { id } });
};

type PostQueryResult = { id: number; name: string; isCategory: boolean; postCount: number }[];
export const getPostTags = async ({
  query,
  limit,
  excludedTagIds,
}: GetPostTagsInput & { excludedTagIds?: number[] }) => {
  const showTrending = query === undefined || query.length < 2;
  const tags = await dbRead.$queryRaw<PostQueryResult>`
    SELECT
      t.id,
      t.name,
      t."isCategory",
      COALESCE(${
        showTrending ? Prisma.sql`s."postCountDay"` : Prisma.sql`s."postCountAllTime"`
      }, 0)::int AS "postCount"
    FROM "Tag" t
    LEFT JOIN "TagStat" s ON s."tagId" = t.id
    LEFT JOIN "TagRank" r ON r."tagId" = t.id
    WHERE
      ${showTrending ? Prisma.sql`t."isCategory" = true` : Prisma.sql`t.name ILIKE ${query + '%'}`}
    ORDER BY ${Prisma.raw(
      showTrending ? `r."postCountDayRank" DESC` : `LENGTH(t.name), r."postCountAllTimeRank" DESC`
    )}
    LIMIT ${limit}
  `;

  return (
    !!excludedTagIds?.length ? tags.filter((x) => !excludedTagIds.includes(x.id)) : tags
  ).sort((a, b) => b.postCount - a.postCount);
};

export const addPostTag = async ({ tagId, id: postId, name: initialName }: AddPostTagInput) => {
  const name = initialName.toLowerCase().trim();
  return await dbWrite.$transaction(async (tx) => {
    const tag = await tx.tag.findUnique({
      where: { name },
      select: { id: true, target: true },
    });
    if (!tag) {
      return await tx.tag.create({
        data: {
          type: TagType.UserGenerated,
          target: [TagTarget.Post],
          name,
          tagsOnPosts: {
            create: {
              postId,
            },
          },
        },
        select: simpleTagSelect,
      });
    } else {
      // update the tag target if needed
      return await tx.tag.update({
        where: { id: tag.id },
        data: {
          target: !tag.target.includes(TagTarget.Post) ? { push: TagTarget.Post } : undefined,
          tagsOnPosts: {
            connectOrCreate: {
              where: { tagId_postId: { tagId: tag.id, postId } },
              create: { postId },
            },
          },
        },
        select: simpleTagSelect,
      });
    }
  });
};

export const removePostTag = ({ tagId, id: postId }: RemovePostTagInput) => {
  return dbWrite.tagsOnPost.delete({ where: { tagId_postId: { tagId, postId } } });
};

export const addPostImage = async ({
  modelVersionId,
  meta,
  ...image
}: AddPostImageInput & { userId: number }) => {
  const partialResult = await dbWrite.image.create({
    data: {
      ...image,
      meta: (meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      generationProcess: meta ? getImageGenerationProcess(meta as Prisma.JsonObject) : null,
    },
    select: { id: true },
  });

  await dbWrite.$executeRaw`SELECT insert_image_resource(${partialResult.id}::int)`;

  const result = await dbWrite.image.findUnique({
    where: { id: partialResult.id },
    select: editPostImageSelect,
  });

  if (!result) throw throwNotFoundError(`Image ${partialResult.id} not found`);
  return result;
};

export const updatePostImage = async (image: UpdatePostImageInput) => {
  // const updateResources = image.resources.filter(isImageResource);
  // const createResources = image.resources.filter(isNotImageResource);

  const result = await dbWrite.image.update({
    where: { id: image.id },
    data: {
      ...image,
      meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
      // resources: {
      //   deleteMany: {
      //     NOT: updateResources.map((r) => ({ id: r.id })),
      //   },
      //   createMany: { data: createResources.map((r) => ({ modelVersionId: r.id, name: r.name })) },
      // },
    },
    select: editPostImageSelect,
  });

  return result;
};

export const reorderPostImages = async ({ imageIds }: ReorderPostImagesInput) => {
  const transaction = dbWrite.$transaction(
    imageIds.map((id, index) =>
      dbWrite.image.update({ where: { id }, data: { index }, select: { id: true } })
    )
  );

  return transaction;
};

export const getPostResources = async ({ id }: GetByIdInput) => {
  return await dbRead.postResourceHelper.findMany({
    where: { postId: id },
    orderBy: { modelName: 'asc' },
  });
};

const colorPriority = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'brown',
  'grey',
];
type PostCategory = { id: number; name: string; priority: number };
export const getPostCategories = async ({
  excludeIds,
  limit,
  cursor,
}: {
  excludeIds?: number[];
  limit?: number;
  cursor?: number;
}) => {
  let categories: PostCategory[] | undefined;
  const categoriesCache = await redis.get('system:categories:posts');
  if (categoriesCache) categories = JSON.parse(categoriesCache);

  if (!categories) {
    const categoriesRaw = await dbRead.tag.findMany({
      where: { target: { has: TagTarget.Post }, isCategory: true },
      select: { id: true, name: true, color: true },
    });
    categories = categoriesRaw
      .map((c) => ({
        id: c.id,
        name: c.name,
        priority: indexOfOr(colorPriority, c.color ?? 'grey', colorPriority.length),
      }))
      .sort((a, b) => a.priority - b.priority);
    await redis.set('system:categories:posts', JSON.stringify(categories));
  }

  if (excludeIds) categories = categories.filter((c) => !excludeIds.includes(c.id));
  let start = 0;
  if (cursor) start = categories.findIndex((c) => c.id === cursor) + 1;
  if (limit) categories = categories.slice(start, start + limit);

  return categories;
};

type GetPostByCategoryRaw = {
  id: number;
  tagId: number;
  nsfw: boolean;
  title: string | null;
  detail: string | null;
  username: string | null;
  userImage: string | null;
  modelVersionId: number | null;
  createdAt: Date;
  publishedAt: Date | null;
  cryCount: number;
  laughCount: number;
  likeCount: number;
  dislikeCount: number;
  heartCount: number;
  commentCount: number;
};
type PostImageRaw = {
  id: number;
  name: string;
  url: string;
  nsfw: boolean;
  width: number;
  height: number;
  hash: string;
  meta: Prisma.JsonValue;
  hideMeta: boolean;
  generationProcess: ImageGenerationProcess;
  createdAt: Date;
  mimeType: string;
  scannedAt: Date;
  needsReview: boolean;
  postId: number;
};
export const getPostsByCategory = async ({
  userId,
  ...input
}: GetPostsByCategoryInput & { userId?: number }) => {
  input.limit ??= 10;

  const categories = await getPostCategories({
    excludeIds: input.excludedTagIds,
    limit: input.limit + 1,
    cursor: input.cursor,
  });

  let nextCursor: number | null = null;
  if (categories.length > input.limit) nextCursor = categories.pop()?.id ?? null;

  const AND = [Prisma.sql`1 = 1`];

  // Apply excluded tags
  if (input.excludedTagIds?.length)
    AND.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "TagsOnPost" top
      WHERE top."postId" = p.id
      AND top."tagId" IN (${Prisma.join(input.excludedTagIds)})
    )`);

  // Apply excluded users
  if (input.excludedUserIds?.length)
    AND.push(Prisma.sql`p."userId" NOT IN (${Prisma.join(input.excludedUserIds)})`);

  // Limit to selected user
  if (input.username) {
    const targetUser = await dbRead.user.findUnique({
      where: { username: input.username },
      select: { id: true },
    });
    if (!targetUser) throw new Error('User not found');
    AND.push(Prisma.sql`p."userId" = ${targetUser.id}`);
  }

  // Limit to selected model/version
  if (input.modelId) AND.push(Prisma.sql`mv."modelId" = ${input.modelId}`);
  if (input.modelVersionId) AND.push(Prisma.sql`p."modelVersionId" = ${input.modelVersionId}`);

  // Apply SFW filter
  if (input.browsingMode === BrowsingMode.SFW) AND.push(Prisma.sql`p."nsfw" = false`);

  let orderBy = `p."publishedAt" DESC`;
  if (input.sort === PostSort.MostReactions)
    orderBy = `pm."likeCount"+pm."heartCount"+pm."laughCount"+pm."cryCount" DESC NULLS LAST, ${orderBy}`;
  else if (input.sort === PostSort.MostComments)
    orderBy = `pm."commentCount" DESC NULLS LAST, ${orderBy}`;

  const targets = categories.map((c) => {
    return Prisma.sql`(
      SELECT
        top."postId", "tagId", row_number() OVER (ORDER BY ${Prisma.raw(orderBy)}) "index"
      FROM "TagsOnPost" top
      JOIN "Post" p ON p.id = top."postId"
        ${Prisma.raw(
          input.period !== 'AllTime'
            ? `AND p."publishedAt" > now() - INTERVAL '1 ${input.period}'`
            : 'AND p."publishedAt" IS NOT NULL'
        )}
      ${Prisma.raw(input.modelId ? `JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"` : '')}
      ${Prisma.raw(
        orderBy.startsWith('pm')
          ? `LEFT JOIN "PostMetric" pm ON pm."postId" = top."postId" AND pm.timeframe = '${input.period}'`
          : ''
      )}
      WHERE top."tagId" = ${c.id}
      AND ${Prisma.join(AND, ' AND ')}
      ORDER BY ${Prisma.raw(orderBy)}
      LIMIT ${Math.ceil((input.postLimit ?? 12) * 1.25)}
    )`;
  });

  const postsRaw = await dbRead.$queryRaw<GetPostByCategoryRaw[]>`
    WITH targets AS (
      ${Prisma.join(targets, ' UNION ALL ')}
    )
    SELECT
      p.id,
      t."tagId",
      p.nsfw,
      p.title,
      p.detail,
      u.username,
      u.image AS "userImage",
      p."modelVersionId",
      p."createdAt",
      p."publishedAt",
      COALESCE(pm."cryCount", 0) "cryCount",
      COALESCE(pm."laughCount", 0) "laughCount",
      COALESCE(pm."likeCount", 0) "likeCount",
      COALESCE(pm."dislikeCount", 0) "dislikeCount",
      COALESCE(pm."heartCount", 0) "heartCount",
      COALESCE(pm."commentCount", 0) "commentCount"
    FROM targets t
    JOIN "Post" p ON p.id = t."postId"
    JOIN "User" u ON u.id = p."userId"
    LEFT JOIN "PostMetric" pm ON pm."postId" = p.id AND pm."timeframe" = 'AllTime'::"MetricTimeframe"
    ORDER BY t."index"
  `;

  const postIds = postsRaw.map((p) => p.id);
  const imageAND = [Prisma.sql`"postId" IN (${Prisma.join(postIds)})`];
  applyUserPreferencesSql(imageAND, { ...input, userId });
  applyModRulesSql(imageAND, { userId });
  const images = await dbRead.$queryRaw<PostImageRaw[]>`
    WITH all_images AS (
      SELECT
        i.id,
        i.name,
        i.url,
        i.nsfw,
        i.width,
        i.height,
        i.hash,
        i.meta,
        i."hideMeta",
        i."generationProcess",
        i."createdAt",
        i."mimeType",
        i."scannedAt",
        i."needsReview",
        i."postId",
        row_number() OVER (PARTITION BY i."postId" ORDER BY i."index") row_number
      FROM "Image" i
      JOIN "Post" p ON p.id = i."postId"
      WHERE ${Prisma.join(imageAND, ' AND ')}
    )
    SELECT
      *
    FROM all_images
    WHERE row_number <= ${input.limit ?? 1}
    ORDER BY row_number;
  `;

  // Convert raw to processed
  const usedImages = new Set();
  const rawToProcess = (raw: GetPostByCategoryRaw) => {
    const image = images.find((i) => i.postId === raw.id && !usedImages.has(i.id));
    if (!image) return null;
    usedImages.add(image.id);
    return {
      ...raw,
      image,
    };
  };

  // Map posts to categories
  const postCategories: Record<number, ReturnType<typeof rawToProcess>[]> = {};
  for (const raw of postsRaw) {
    const processed = rawToProcess(raw);
    if (!processed) continue;
    if (!postCategories[raw.tagId]) postCategories[raw.tagId] = [];
    postCategories[raw.tagId].push(processed);
  }

  // Map category record to array
  const items = categories
    .map((c) => {
      const items = postCategories[c.id]?.filter(isDefined);
      if (!items) return null;
      return { ...c, items };
    })
    .filter(isDefined);

  return { items, nextCursor };
};
