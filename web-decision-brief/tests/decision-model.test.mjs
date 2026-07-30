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
        no: "1A",
        projectId: "agent",
        projectLabel: "客服 Agent",
        pathOptions: ["A", "B", "C"],
        pathValue: "",
        checked: false,
        html: "客服 Agent",
      },
      {
        rowId: "filing-path",
        no: "1B",
        projectId: "filing",
        projectLabel: "供应链备案识别",
        pathOptions: ["A", "B", "C"],
        pathValue: "",
        checked: false,
        html: "供应链备案识别",
      },
      {
        rowId: "fee",
        no: "2",
        kind: "fee",
        checked: false,
        html: "费用与止损",
        feeFields: {
          total: "7000",
          monthCap: "5000",
          allCap: "10000",
          otherNote: "",
        },
      },
      {
        rowId: "agent-owner",
        no: "3A",
        kind: "owner",
        projectId: "agent",
        projectLabel: "客服 Agent",
        checked: false,
        html: "客服 Owner",
        owners: [{ name: "", dept: "", scope: "" }],
      },
      {
        rowId: "filing-owner",
        no: "3B",
        kind: "owner",
        projectId: "filing",
        projectLabel: "供应链备案识别",
        checked: false,
        html: "供应链 Owner",
        owners: [{ name: "", dept: "", scope: "" }],
      },
      {
        rowId: "stop",
        no: "5",
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

test("初态必须分别补齐两个项目路径", () => {
  const gate = evaluateCheckGate(decisionBlock());
  assert.equal(gate.isMinOk, false);
  assert.deepEqual(gate.missing, ["客服 Agent路径", "供应链备案识别路径"]);
});

test("C/C 是完整的不立结论，不强制费用与 Owner", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "C";
  block.rows[0].checked = true;
  block.rows[1].pathValue = "C";
  block.rows[1].checked = true;
  const gate = evaluateCheckGate(block);
  assert.equal(gate.allC, true);
  assert.equal(gate.isMinOk, true);
  assert.deepEqual(gate.missing, []);
});

test("A/C 只要求 A 项目的 Owner，并要求费用与停扩授权", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "A";
  block.rows[0].checked = true;
  block.rows[1].pathValue = "C";
  block.rows[1].checked = true;

  let gate = evaluateCheckGate(block);
  assert.deepEqual(gate.missing, [
    "客服 Agent Owner",
    "费用与止损确认",
    "超线停扩授权",
  ]);

  block.rows[2].checked = true;
  block.rows[3].checked = true;
  block.rows[3].owners[0] = { name: "李负责人", dept: "客服部", scope: "客服 Agent" };
  block.rows[5].checked = true;
  gate = evaluateCheckGate(block);
  assert.equal(gate.isMinOk, true);
  assert.deepEqual(gate.missing, []);
});

test("A/B 分别要求各自 Owner，错误预算会阻断门禁", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "A";
  block.rows[0].checked = true;
  block.rows[1].pathValue = "B";
  block.rows[1].checked = true;
  block.rows[2].checked = true;
  block.rows[2].feeFields.total = "12000";
  block.rows[3].checked = true;
  block.rows[3].owners[0].name = "客服负责人";
  block.rows[4].checked = true;
  block.rows[4].owners[0].name = "供应链负责人";
  block.rows[5].checked = true;

  const gate = evaluateCheckGate(block);
  assert.equal(gate.isMinOk, false);
  assert.deepEqual(gate.missing, ["目标预算不能高于全期止损"]);
});

test("会议凭证可校验，任意篡改都会失效", () => {
  const block = decisionBlock();
  block.rows[0].pathValue = "C";
  block.rows[0].checked = true;
  block.rows[1].pathValue = "C";
  block.rows[1].checked = true;
  const context = {
    generatedAt: "2026-07-29T10:30:00.000Z",
    contentVersion: "5.20.0",
    decisionSchemaVersion: 2,
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
  block.rows[1].pathValue = "C";
  block.rows[1].checked = true;
  block.rows[2].checked = true;
  block.rows[3].checked = true;
  block.rows[3].owners[0] = { name: "李负责人", dept: "客服部", scope: "客服 Agent" };
  block.rows[5].checked = true;
  const text = buildMeetingConclusionText(block, {
    generatedAt: "2026-07-29T10:30:00.000Z",
    contentVersion: "5.20.0",
    decisionSchemaVersion: 2,
    sourceStamp: "contract-test",
  });
  assert.match(text, /客服 Agent · 路径：A 同意启动/);
  assert.match(text, /供应链备案识别 · 路径：C 不立/);
  assert.match(text, /飞书 \/ 邮件并由相关人确认后才构成正式留痕/);
  assert.match(text, /凭证哈希（SHA-256）：[a-f0-9]{64}/);
});
