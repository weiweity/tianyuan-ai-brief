import test from "node:test";
import assert from "node:assert/strict";

import { mergeMeetingState } from "../docs/js/modules/meeting-state.js";

function contentFixture(schema = 2) {
  return {
    decisionSchemaVersion: schema,
    tabs: [
      {
        id: "t6",
        blocks: [
          {
            id: "t6.check",
            type: "check-table",
            rows: [
              {
                rowId: "agent-path",
                no: "1A",
                checked: false,
                pathOptions: ["A", "B", "C"],
                pathValue: "",
              },
              {
                rowId: "fee",
                no: "2",
                checked: false,
                feeFields: {
                  total: "7000",
                  monthCap: "5000",
                  allCap: "10000",
                  otherNote: "",
                },
              },
              {
                rowId: "owner",
                no: "3A",
                checked: false,
                owners: [{ name: "", dept: "", scope: "" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

test("决策 Schema 不同则整批拒绝旧会议状态", () => {
  const previous = contentFixture(1);
  previous.tabs[0].blocks[0].rows[0].pathValue = "A";
  const incoming = contentFixture(2);
  const result = mergeMeetingState(previous, incoming);
  assert.equal(result.outcome, "schema-mismatch");
  assert.equal(result.content.tabs[0].blocks[0].rows[0].pathValue, "");
});

test("合并不修改输入且只保留显式白名单字段", () => {
  const previous = contentFixture();
  const rows = previous.tabs[0].blocks[0].rows;
  rows[0].pathValue = "B";
  rows[0].checked = true;
  rows[1].checked = true;
  rows[1].feeFields = {
    total: "6500",
    monthCap: "4500",
    allCap: "9000",
    otherNote: "审批中",
    injected: "<script>",
  };
  rows[2].checked = true;
  rows[2].owners = [
    { name: "李负责人", dept: "客服部", scope: "客服 Agent", admin: true },
    { name: "越界人员", dept: "其他", scope: "不应新增" },
  ];
  const incoming = contentFixture();
  const originalIncoming = structuredClone(incoming);

  const result = mergeMeetingState(previous, incoming);
  const merged = result.content.tabs[0].blocks[0].rows;
  assert.deepEqual(incoming, originalIncoming);
  assert.equal(result.outcome, "aligned-with-drops");
  assert.equal(merged[0].pathValue, "B");
  assert.deepEqual(merged[1].feeFields, {
    total: "6500",
    monthCap: "4500",
    allCap: "9000",
    otherNote: "审批中",
  });
  assert.deepEqual(merged[2].owners, [
    { name: "李负责人", dept: "客服部", scope: "客服 Agent" },
  ]);
});

test("无效路径不会跨内容版本污染新状态", () => {
  const previous = contentFixture();
  previous.tabs[0].blocks[0].rows[0].pathValue = "D";
  const result = mergeMeetingState(previous, contentFixture());
  assert.equal(result.outcome, "aligned-with-drops");
  assert.equal(result.droppedFields, 1);
  assert.equal(result.content.tabs[0].blocks[0].rows[0].pathValue, "");
});
