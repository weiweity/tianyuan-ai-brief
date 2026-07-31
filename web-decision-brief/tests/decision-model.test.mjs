import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDecisionReceipt,
  buildMeetingConclusionText,
  evaluateCheckGate,
  sha256,
  verifyDecisionReceipt,
} from "../docs/js/modules/decision-model.js";

function decisionBlock() {
  return {
    id: "t6.check",
    rows: [
      {
        rowId: "agent-path",
        no: "1",
        projectId: "agent",
        projectLabel: "客服话术库 MVP-A",
        pathOptions: ["A", "B", "C"],
        pathValue: "",
        checked: false,
        html: "客服话术库 MVP-A",
      },
      {
        rowId: "fee",
        no: "2",
        kind: "fee",
        checked: false,
        html: "费用与止损",
        feeFields: {
          total: "3000",
          monthCap: "1000",
          allCap: "5000",
          otherNote: "",
        },
      },
      {
        rowId: "agent-owner",
        no: "3",
        kind: "owner",
        projectId: "agent",
        projectLabel: "客服话术库 MVP-A",
        checked: false,
        html: "客服 Owner",
        owners: [{ name: "", dept: "", scope: "" }],
      },
      {
        rowId: "stop",
        no: "6",
        kind: "stop-authority",
        checked: false,
        html: "超线停扩",
      },
    ],
  };
}

test("SHA-256 与标准测试向量一致", () => {
  assert.equal(
    sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("初态必须补齐客服单项目执行路径", () => {
  const gate = evaluateCheckGate(decisionBlock());
  assert.equal(gate.isMinOk, false);
  assert.deepEqual(gate.missing, ["客服话术库 MVP-A路径"]);
});

test("客服路径 C 是完整的暂停执行记录，不强制费用与 Owner", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "C";
  block.rows[0].checked = true;
  const gate = evaluateCheckGate(block);
  assert.equal(gate.allC, true);
  assert.equal(gate.isMinOk, true);
  assert.deepEqual(gate.missing, []);
});

test("必须级外部凭证确认不能被路径、费用或 Owner 代替", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "C";
  block.rows[0].checked = true;
  block.rows.push({
    rowId: "approval-evidence",
    no: "4",
    checked: false,
    tier: "must",
    html: "<b>公司正式批准凭证</b>已归档",
  });

  let gate = evaluateCheckGate(block);
  assert.equal(gate.isMinOk, false);
  assert.deepEqual(gate.missing, ["公司正式批准凭证已归档"]);

  block.rows.at(-1).checked = true;
  gate = evaluateCheckGate(block);
  assert.equal(gate.isMinOk, true);
});

test("客服路径 A 要求客服 Owner、费用与停扩授权", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "A";
  block.rows[0].checked = true;

  let gate = evaluateCheckGate(block);
  assert.deepEqual(gate.missing, [
    "客服话术库 MVP-A Owner",
    "费用与止损确认",
    "超线停扩授权",
  ]);

  block.rows[1].checked = true;
  block.rows[2].checked = true;
  block.rows[2].owners[0] = { name: "李负责人", dept: "客服部", scope: "客服话术库 MVP-A" };
  block.rows[3].checked = true;
  gate = evaluateCheckGate(block);
  assert.equal(gate.isMinOk, true);
  assert.deepEqual(gate.missing, []);
});

test("客服路径 B 同样要求 Owner、费用与停扩，错误预算会阻断门禁", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "B";
  block.rows[0].checked = true;
  block.rows[1].checked = true;
  block.rows[1].feeFields.total = "6000";
  block.rows[2].checked = true;
  block.rows[2].owners[0].name = "客服负责人";
  block.rows[3].checked = true;

  const gate = evaluateCheckGate(block);
  assert.equal(gate.isMinOk, false);
  assert.deepEqual(gate.missing, ["目标预算不能高于全期止损"]);
});

test("客服路径 B 允许金额后置，但仍要求业务 Owner 与停扩授权", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "B";
  block.rows[0].checked = true;
  block.rows[1].feeFields = { total: "", monthCap: "", allCap: "", otherNote: "" };
  block.rows[2].checked = true;
  block.rows[2].owners[0].name = "客服负责人";
  block.rows[3].checked = true;

  const gate = evaluateCheckGate(block);
  assert.equal(gate.isMinOk, true);
  assert.deepEqual(gate.missing, []);
});

test("显式 stop-authority 优先于历史第 5 行兼容规则", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "A";
  block.rows[0].checked = true;
  block.rows[1].checked = true;
  block.rows[2].checked = true;
  block.rows[2].owners[0].name = "客服负责人";
  block.rows[3].checked = true;
  block.rows.splice(3, 0, {
    rowId: "g0-review",
    no: "5",
    checked: false,
    tier: "later",
    html: "G0 其它门禁复核",
  });

  const gate = evaluateCheckGate(block);
  assert.equal(gate.stopRow.kind, "stop-authority");
  assert.equal(gate.isMinOk, true);
});

test("会议凭证可校验，任意篡改都会失效", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "C";
  block.rows[0].checked = true;
  const context = {
    generatedAt: "2026-07-29T10:30:00.000Z",
    contentVersion: "5.25.1",
    decisionSchemaVersion: 3,
    sourceStamp: "contract-test",
  };
  const receipt = buildDecisionReceipt(block, context);
  assert.equal(receipt.minimumReady, true);
  assert.equal(verifyDecisionReceipt(receipt), true);
  receipt.projects[0].path = "A";
  assert.equal(verifyDecisionReceipt(receipt), false);
});

test("复制结论包含逐项目路径、正式留痕边界和凭证哈希", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "A";
  block.rows[0].checked = true;
  block.rows[1].checked = true;
  block.rows[2].checked = true;
  block.rows[2].owners[0] = { name: "李负责人", dept: "客服部", scope: "客服话术库 MVP-A" };
  block.rows[3].checked = true;
  const text = buildMeetingConclusionText(block, {
    generatedAt: "2026-07-29T10:30:00.000Z",
    contentVersion: "5.25.1",
    decisionSchemaVersion: 3,
    sourceStamp: "contract-test",
  });
  assert.match(text, /客服话术库 MVP-A · 路径：A 费用已批，可执行/);
  assert.match(text, /飞书 \/ 邮件并由相关人确认后才构成正式留痕/);
  assert.match(text, /凭证哈希（SHA-256）：[a-f0-9]{64}/);
});
