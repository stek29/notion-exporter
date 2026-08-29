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
): Promise<BlockTreeResult> {
  const childPages = new Set<string>();
  const childDatabases = new Set<string>();
  const blockIds: string[] = [];

  const walk = async (id: string): Promise<BlockWithChildren[]> => {
    const children = await api.listBlockChildren(id);
    return Promise.all(
      children.map(async (block) => {
        blockIds.push(block.id);
        if (block.object === "page" || block.type === "child_page")
          childPages.add(block.id);
        if (block.object === "database" || block.type === "child_database")
          childDatabases.add(block.id);
        const transformed = transform ? await transform(block) : block;
        const nested = block.has_children === true ? await walk(block.id) : [];
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
