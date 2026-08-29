import type { NotionApi } from "../notion/api.js";
import type { NotionObject } from "../shared/types.js";

export interface BlockWithChildren extends NotionObject {
  children: BlockWithChildren[];
}

export interface BlockTreeResult {
  blocks: BlockWithChildren[];
  childPages: string[];
  childDatabases: string[];
  blockIds: string[];
}

export async function retrieveBlockTree(
  api: NotionApi,
  parentId: string,
  transform?: (block: NotionObject) => Promise<NotionObject>,
  include?: (block: NotionObject) => boolean,
): Promise<BlockTreeResult> {
  const childPages = new Set<string>();
  const childDatabases = new Set<string>();
  const blockIds: string[] = [];

  const walk = async (id: string): Promise<BlockWithChildren[]> => {
    const children = await api.listBlockChildren(id);
    return Promise.all(
      children
        .filter((block) => include?.(block) ?? true)
        .map(async (block) => {
          blockIds.push(block.id);
          const isChildPage =
            block.object === "page" || block.type === "child_page";
          const isChildDatabase =
            block.object === "database" || block.type === "child_database";
          if (isChildPage) childPages.add(block.id);
          if (isChildDatabase) childDatabases.add(block.id);
          const transformed = transform ? await transform(block) : block;
          // A child page/database is a traversal edge, not an ordinary nested block.
          // Its content is exported canonically under its own resource directory.
          const nested =
            block.has_children === true && !isChildPage && !isChildDatabase
              ? await walk(block.id)
              : [];
          return { ...transformed, children: nested };
        }),
    );
  };

  return {
    blocks: await walk(parentId),
    childPages: [...childPages].sort(),
    childDatabases: [...childDatabases].sort(),
    blockIds,
  };
}
