const FEE_FIELDS = Object.freeze(["total", "monthCap", "allCap", "otherNote"]);
const OWNER_FIELDS = Object.freeze(["name", "dept", "scope"]);

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function rowKey(row) {
  if (!row) return "";
  if (row.rowId) return String(row.rowId);
  if (row.no != null && row.no !== "") return `no:${String(row.no)}`;
  return "";
}

function optionKeys(options, objectKey) {
  return (options || [])
    .map((option) => (typeof option === "string" ? option : option && option[objectKey]))
    .filter(Boolean);
}

function namedOwners(row) {
  return Array.isArray(row && row.owners)
    ? row.owners.filter((owner) => owner && String(owner.name || "").trim())
    : [];
}

function safeText(value) {
  return typeof value === "string" ? value : "";
}

export function createMeetingBlockPersister(persist, rollback, onFailure) {
  return (block, previousBlock) => {
    if (persist()) return true;
    Object.assign(block, JSON.parse(previousBlock));
    rollback();
    onFailure();
    return false;
  };
}

/**
 * 还原单个会议补录块的本机状态，保留行 ID、文案和选项结构。
 * 返回新对象，避免清空操作留下半更新的原对象。
 */
export function clearMeetingBlockState(block) {
  const cleared = clone(block);
  if (!cleared || !Array.isArray(cleared.rows)) return cleared;

  cleared.rows.forEach((row) => {
    row.checked = false;
    if (Array.isArray(row.pathOptions)) row.pathValue = "";
    if (Array.isArray(row.multiOptions)) {
      row.multiValues = [];
      row.otherText = "";
    }
    if (row.feeFields && typeof row.feeFields === "object") {
      Object.keys(row.feeFields).forEach((field) => {
        row.feeFields[field] = "";
      });
    }
    if (Array.isArray(row.owners)) {
      row.owners = row.owners.map(() => ({ name: "", dept: "", scope: "" }));
    }
    if (row.ownerFields) {
      row.ownerFields = { name: "", dept: "", scope: "", backup: "" };
    }
  });
  return cleared;
}

function mergeFeeFields(target, source) {
  const merged = { ...target };
  FEE_FIELDS.forEach((field) => {
    if (typeof source[field] === "string") merged[field] = source[field];
  });
  return merged;
}

function mergeOwners(targetOwners, sourceOwners) {
  return targetOwners.map((target, index) => {
    const source = sourceOwners[index] || {};
    const merged = { ...target };
    OWNER_FIELDS.forEach((field) => {
      if (typeof source[field] === "string") merged[field] = source[field];
    });
    return merged;
  });
}

/**
 * 把旧页面中的本机会议态合并进新内容。
 *
 * - 不修改任一输入；
 * - 决策 Schema 不同即整批拒绝；
 * - 只允许显式状态字段，不允许旧草稿注入新结构或额外键。
 */
export function mergeMeetingState(previous, incoming) {
  const content = clone(incoming);
  if (!previous || !content || !previous.tabs || !content.tabs) {
    return { content, outcome: "unchanged", droppedFields: 0 };
  }
  const previousSchema = Number(previous.decisionSchemaVersion || 1);
  const incomingSchema = Number(content.decisionSchemaVersion || 1);
  if (previousSchema !== incomingSchema) {
    return { content, outcome: "schema-mismatch", droppedFields: 0 };
  }

  const previousBlocks = new Map();
  previous.tabs.forEach((tab) => {
    (tab.blocks || []).forEach((block) => {
      if (block.type === "check-table" && block.id) previousBlocks.set(block.id, block);
    });
  });

  let droppedFields = 0;
  let mergedRows = 0;
  content.tabs.forEach((tab) => {
    (tab.blocks || []).forEach((block) => {
      const oldBlock = previousBlocks.get(block.id);
      if (
        block.type !== "check-table" ||
        !oldBlock ||
        !Array.isArray(oldBlock.rows) ||
        !Array.isArray(block.rows)
      ) {
        return;
      }
      const oldRows = new Map();
      oldBlock.rows.forEach((row, index) => oldRows.set(rowKey(row) || `idx:${index}`, row));

      block.rows.forEach((row, index) => {
        const oldRow =
          oldRows.get(rowKey(row) || `idx:${index}`) ||
          oldBlock.rows.find(
            (candidate) =>
              String(candidate.no) === String(row.no) && (!row.rowId || !candidate.rowId)
          );
        if (!oldRow) return;
        mergedRows += 1;

        if (typeof oldRow.checked === "boolean") row.checked = oldRow.checked;

        if (Array.isArray(row.pathOptions) && typeof oldRow.pathValue === "string") {
          const validPaths = optionKeys(row.pathOptions, "value");
          if (!oldRow.pathValue) {
            row.pathValue = "";
          } else if (validPaths.includes(oldRow.pathValue)) {
            row.pathValue = oldRow.pathValue;
            row.checked = true;
          } else {
            droppedFields += 1;
          }
        }

        if (Array.isArray(row.multiOptions) && Array.isArray(oldRow.multiValues)) {
          const validMulti = new Set(optionKeys(row.multiOptions, "id"));
          if (validMulti.size) {
            const kept = oldRow.multiValues.filter((value) => validMulti.has(value));
            row.multiValues = kept;
            droppedFields += oldRow.multiValues.length - kept.length;
            if (kept.length) row.checked = true;
          } else {
            droppedFields += oldRow.multiValues.length;
          }
        }
        if (Array.isArray(row.multiOptions) && typeof oldRow.otherText === "string") {
          row.otherText = oldRow.otherText;
        }

        if (oldRow.feeFields) {
          if (row.feeFields) {
            row.feeFields = mergeFeeFields(row.feeFields, oldRow.feeFields);
            if (oldRow.checked) row.checked = true;
          } else {
            droppedFields += 1;
          }
        }

        if (Array.isArray(row.owners)) {
          if (Array.isArray(oldRow.owners)) {
            row.owners = mergeOwners(row.owners, oldRow.owners);
            if (namedOwners(row).length) row.checked = true;
            if (oldRow.owners.length > row.owners.length) {
              droppedFields += oldRow.owners.length - row.owners.length;
            }
          } else if (oldRow.ownerFields && safeText(oldRow.ownerFields.name).trim()) {
            const first = row.owners[0] || { name: "", dept: "", scope: "" };
            row.owners[0] = {
              ...first,
              name: safeText(oldRow.ownerFields.name),
              dept: safeText(oldRow.ownerFields.dept) || first.dept,
              scope:
                safeText(oldRow.ownerFields.scope) ||
                safeText(oldRow.ownerFields.backup) ||
                first.scope,
            };
            row.checked = true;
          }
        }
      });
    });
  });

  return {
    content,
    outcome: droppedFields ? "aligned-with-drops" : mergedRows ? "merged" : "unchanged",
    droppedFields,
  };
}
