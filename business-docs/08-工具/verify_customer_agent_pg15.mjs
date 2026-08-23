#!/usr/bin/env node

import { createHash, randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_SCHEMA_SHA256 =
  "47b667958e522a28df1c04d7c79a56c930bfe0ac04598321824b55744ac4a801";
const VERIFIER_VERSION = "1.2.0";
const REQUIRED_SCHEMA_COMMENT_FRAGMENTS = [
  "reference DDL local-preflight status is recorded only by external EVD (not this DDL)",
  "immutable migration/N/N-1/application runtime/managed PostgreSQL/backup-restore/concurrency/production remain NOT_CERTIFIED",
];
const PROJECT_CODE = "CS-AI-C11";
const OWNER_ROLE = "gate_owner";
const REQUIRED_ROLES = [
  "cs_ai_definer",
  "app_runtime",
  "app_content_admin",
  "app_import_worker",
  "app_work_order_worker",
];
const REQUIRED_TABLES = [
  "app_users",
  "privacy_notices",
  "notice_decisions",
  "authoritative_source_versions",
  "authoritative_source_suspensions",
  "intent_taxonomy_versions",
  "intent_taxonomy_entries",
  "intent_taxonomy_mappings",
  "scripts",
  "script_questions",
  "semantic_source_assets",
  "query_events",
  "candidate_impressions",
  "adoption_events",
  "escalate_actions",
  "iteration_tasks",
  "iteration_task_status_audits",
  "work_order_import_batches",
  "work_order_records",
  "work_order_export_audits",
  "change_audits",
  "import_batches",
  "content_quality_review_plans",
  "content_quality_review_evidence",
  "content_review_decisions",
  "import_batch_source_bindings",
  "staging_scripts",
  "content_releases",
  "release_source_bindings",
  "release_items",
  "content_current",
  "announcements",
  "snapshot_offline_leases",
  "source_denial_audits",
  "client_sync_state",
  "policy_flags",
  "idempotency_keys",
  "rate_limit_buckets",
  "outbox_jobs",
];
const REQUIRED_VIEWS = ["v_release_source_gate", "v_scripts_recommendable"];
const REQUIRED_FUNCTIONS = [
  "publish_content_release",
  "rollback_content_release",
  "enqueue_content_import",
  "enqueue_work_order_import",
  "search_recommendable_scripts",
  "issue_snapshot_offline_lease",
  "validate_snapshot_offline_lease",
  "read_snapshot_page",
  "record_source_denial_audit",
  "record_runtime_source_denial_audit",
  "record_admin_source_denial_audit",
  "record_content_review_decision",
  "freeze_content_quality_review_plan",
  "record_content_quality_review_evidence",
  "finalize_content_import_validation",
  "finalize_work_order_import_validation",
];

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
const schemaPath = path.join(
  repoRoot,
  "business-docs/01-客服Agent项目/20-设计-进行中/33-schema-v1-草案.sql",
);
const evidenceRoot = path.join(repoRoot, "output/customer-agent-pg15-gate");

function usage() {
  return [
    "用法：node business-docs/08-工具/verify_customer_agent_pg15.mjs [--pg-bin=/path/to/postgresql/bin]",
    "",
    "这个命令只会创建一个临时 PostgreSQL 15 cluster，禁用 TCP，并在结束时删除 PGDATA/WAL。",
    "它不连接现有数据库，不修改 G0/Scope/Ddev，也不认证 migration/runtime/生产环境。",
  ].join("\n");
}

function parseArgs(argv) {
  let pgBin = null;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg.startsWith("--pg-bin=")) {
      pgBin = path.resolve(arg.slice("--pg-bin=".length));
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return { pgBin };
}

function pgEnvironment() {
  const env = { ...process.env, PGCONNECT_TIMEOUT: "5" };
  for (const key of [
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSFILE",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGOPTIONS",
  ]) {
    delete env[key];
  }
  return env;
}

function binary(pgBin, name) {
  return pgBin ? path.join(pgBin, name) : name;
}

function shellQuoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function shanghaiParts(date = new Date()) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function shanghaiStamp(date = new Date()) {
  const parts = shanghaiParts(date);
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}+0800`;
}

function shanghaiIso(date = new Date()) {
  const parts = shanghaiParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function startProcess(command, args, { env, timeoutMs = 120_000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: env ?? pgEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        code: code ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (!allowFailure && result.code !== 0) {
        const error = new Error(`${path.basename(command)} 执行失败（exit ${result.code}）`);
        error.result = result;
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function sqlStateFrom(result) {
  const combined = `${result.stderr}\n${result.stdout}`;
  return combined.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] ?? null;
}

async function main() {
  if (process.platform === "win32") {
    throw new Error("本预检固定使用 Unix socket；Windows 上请在 WSL/Linux 中运行，不得改为连接现有服务。");
  }

  const { pgBin } = parseArgs(process.argv.slice(2));
  if (pgBin) await access(pgBin, fsConstants.R_OK | fsConstants.X_OK);

  const verifierSha = sha256(await readFile(scriptPath));
  const schema = await readFile(schemaPath, "utf8");
  const schemaSha = sha256(schema);
  if (schemaSha !== EXPECTED_SCHEMA_SHA256) {
    throw new Error(
      `schema SHA-256 不匹配：expected ${EXPECTED_SCHEMA_SHA256}, got ${schemaSha}。请先审查并显式升级预检器。`,
    );
  }
  if (!/^-- schema\.v1\.12\b/m.test(schema)) {
    throw new Error("schema 版本头不是 v1.12，拒绝使用旧预检口径。");
  }

  const postgresVersion = await startProcess(binary(pgBin, "postgres"), ["--version"]);
  const versionMatch = postgresVersion.stdout.match(/PostgreSQL\)\s+(\d+)\.(\d+)/);
  if (!versionMatch || Number(versionMatch[1]) !== 15) {
    throw new Error(`需要 PostgreSQL 15，当前为：${postgresVersion.stdout.trim() || "unknown"}`);
  }
  const pgVersion = `${versionMatch[1]}.${versionMatch[2]}`;

  const tempPrefix = path.join(tmpdir(), "csai-pg15-");
  const tempRoot = await mkdtemp(tempPrefix);
  const pgData = path.join(tempRoot, "data");
  const socketDir = path.join(tempRoot, "socket");
  const serverLog = path.join(tempRoot, "postgres.log");
  const rollbackSqlPath = path.join(tempRoot, "schema-rollback-probe.sql");
  const port = randomInt(49_152, 65_535);
  const mainDb = `csai_gate_${randomBytes(6).toString("hex")}`;
  const rollbackDb = `csai_rollback_${randomBytes(6).toString("hex")}`;
  const pgEnv = pgEnvironment();
  let started = false;
  let startAttempted = false;
  let successfulReport = null;

  function sanitize(text) {
    return String(text ?? "")
      .replaceAll(tempRoot, "<temporary-cluster>")
      .replaceAll(pgData, "<temporary-pgdata>")
      .replaceAll(socketDir, "<temporary-socket>")
      .replaceAll(mainDb, "<ephemeral-database>")
      .replaceAll(rollbackDb, "<ephemeral-database>")
      .replaceAll(String(port), "<random-port>");
  }

  async function cleanup() {
    const postmasterPid = path.join(pgData, "postmaster.pid");
    if (started || (startAttempted && (await pathExists(postmasterPid)))) {
      const stopResult = await startProcess(
        binary(pgBin, "pg_ctl"),
        ["-D", pgData, "-m", "immediate", "-w", "stop"],
        { env: pgEnv, timeoutMs: 30_000, allowFailure: true },
      );
      started = false;
      startAttempted = false;
      if (stopResult.code !== 0) {
        throw new Error("临时 PostgreSQL cluster 未能确认停止，本轮不产生 PASS 证据。");
      }
    }
    const expectedPrefix = path.join(tmpdir(), "csai-pg15-");
    if (!tempRoot.startsWith(expectedPrefix)) {
      throw new Error("临时目录边界校验失败，拒绝删除。");
    }
    await rm(tempRoot, { recursive: true, force: true });
    if (await pathExists(tempRoot)) {
      throw new Error("临时 PGDATA/WAL 没有完全删除，本轮不产生 PASS 证据。");
    }
  }

  async function psqlArgs(database, extra = []) {
    return [
      "-X",
      "--no-psqlrc",
      "--host",
      socketDir,
      "--port",
      String(port),
      "--username",
      OWNER_ROLE,
      "--dbname",
      database,
      "--set=ON_ERROR_STOP=1",
      "--set=VERBOSITY=verbose",
      ...extra,
    ];
  }

  async function runSql(sql, database = mainDb, allowFailure = false) {
    return startProcess(binary(pgBin, "psql"), await psqlArgs(database, ["--command", sql]), {
      env: pgEnv,
      allowFailure,
    });
  }

  async function runSqlFile(file, database = mainDb, allowFailure = false) {
    return startProcess(binary(pgBin, "psql"), await psqlArgs(database, ["--file", file]), {
      env: pgEnv,
      timeoutMs: 180_000,
      allowFailure,
    });
  }

  async function queryScalar(sql, database = mainDb) {
    const result = await startProcess(
      binary(pgBin, "psql"),
      await psqlArgs(database, ["--tuples-only", "--no-align", "--quiet", "--command", sql]),
      { env: pgEnv },
    );
    return result.stdout.trim();
  }

  async function expectSqlState(id, sql, expectedState, database = mainDb) {
    const result = await runSql(sql, database, true);
    const observed = sqlStateFrom(result);
    if (result.code === 0 || observed !== expectedState) {
      throw new Error(
        `${id} 未得到预期 SQLSTATE ${expectedState}，实际为 ${observed ?? `exit ${result.code}`}。`,
      );
    }
    return { id, status: "PASS", expected_sqlstate: expectedState, observed_sqlstate: observed };
  }

  const interruptHandler = async (signal) => {
    try {
      await cleanup();
    } catch {
      // The normal finally path and OS process cleanup remain the fallback.
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interruptHandler);
  process.once("SIGTERM", interruptHandler);

  try {
    await mkdir(socketDir, { recursive: true, mode: 0o700 });
    await startProcess(
      binary(pgBin, "initdb"),
      [
        "-D",
        pgData,
        `--username=${OWNER_ROLE}`,
        "--auth-local=trust",
        "--auth-host=reject",
        "--encoding=UTF8",
        "--locale=C",
        "--no-sync",
      ],
      { env: pgEnv },
    );
    if (socketDir.includes("'")) throw new Error("临时 socket 路径不可安全写入 PostgreSQL 配置。");
    await appendFile(
      path.join(pgData, "postgresql.conf"),
      [
        "",
        "# CS-AI-C11 isolated reference-DDL preflight",
        "listen_addresses = ''",
        `unix_socket_directories = ${shellQuoteSql(socketDir)}`,
        "unix_socket_permissions = 0700",
        `port = ${port}`,
        "timezone = 'Asia/Shanghai'",
        "logging_collector = off",
        "",
      ].join("\n"),
      "utf8",
    );
    startAttempted = true;
    await startProcess(
      binary(pgBin, "pg_ctl"),
      ["-D", pgData, "-l", serverLog, "-w", "start"],
      { env: pgEnv, timeoutMs: 60_000 },
    );
    started = true;

    const serverVersionNum = Number(await queryScalar("SHOW server_version_num;", "postgres"));
    if (!Number.isInteger(serverVersionNum) || Math.trunc(serverVersionNum / 10_000) !== 15) {
      throw new Error(`临时 server 必须为 PostgreSQL 15，实际 server_version_num=${serverVersionNum}。`);
    }
    const listenAddresses = await queryScalar("SHOW listen_addresses;", "postgres");
    const activeSocketDirectory = await queryScalar("SHOW unix_socket_directories;", "postgres");
    if (listenAddresses !== "" || activeSocketDirectory !== socketDir) {
      throw new Error("临时 server 未按要求禁用 TCP 或未使用本轮私有 Unix socket。");
    }

    for (const database of [mainDb, rollbackDb]) {
      await startProcess(
        binary(pgBin, "createdb"),
        [
          "--host",
          socketDir,
          "--port",
          String(port),
          "--username",
          OWNER_ROLE,
          "--owner",
          OWNER_ROLE,
          database,
        ],
        { env: pgEnv },
      );
    }

    await runSqlFile(schemaPath);

    const missingTables = await queryScalar(
      `SELECT COALESCE(string_agg(name, ',' ORDER BY name), '')
         FROM unnest(ARRAY[${REQUIRED_TABLES.map(shellQuoteSql).join(",")}]) AS required(name)
        WHERE to_regclass('public.' || name) IS NULL;`,
    );
    const missingViews = await queryScalar(
      `SELECT COALESCE(string_agg(name, ',' ORDER BY name), '')
         FROM unnest(ARRAY[${REQUIRED_VIEWS.map(shellQuoteSql).join(",")}]) AS required(name)
        WHERE to_regclass('public.' || name) IS NULL;`,
    );
    const missingFunctions = await queryScalar(
      `SELECT COALESCE(string_agg(name, ',' ORDER BY name), '')
         FROM unnest(ARRAY[${REQUIRED_FUNCTIONS.map(shellQuoteSql).join(",")}]) AS required(name)
        WHERE NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = required.name
        );`,
    );
    if (missingTables || missingViews || missingFunctions) {
      throw new Error(
        `对象清单不完整：tables=${missingTables || "ok"}, views=${missingViews || "ok"}, functions=${missingFunctions || "ok"}`,
      );
    }

    const inventory = JSON.parse(
      await queryScalar(`
        SELECT json_build_object(
          'tables', (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')),
          'views', (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v'),
          'functions', (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),
          'extensions', (SELECT json_object_agg(extname, extversion ORDER BY extname) FROM pg_catalog.pg_extension WHERE extname IN ('pgcrypto','pg_trgm'))
        )::text;
      `),
    );
    if (!inventory.extensions?.pgcrypto || !inventory.extensions?.pg_trgm) {
      throw new Error("pgcrypto / pg_trgm 扩展清单不完整。");
    }

    const roleSummary = JSON.parse(
      await queryScalar(`
        SELECT json_build_object(
          'safe_role_count', count(*) FILTER (
            WHERE NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
              AND NOT rolreplication AND NOT rolbypassrls
          ),
          'role_count', count(*)
        )::text
          FROM pg_catalog.pg_roles
         WHERE rolname IN (${REQUIRED_ROLES.map(shellQuoteSql).join(",")});
      `),
    );
    const membershipCount = Number(
      await queryScalar(`
        SELECT count(*)
          FROM pg_catalog.pg_auth_members m
          JOIN pg_catalog.pg_roles member_role ON member_role.oid=m.member
          JOIN pg_catalog.pg_roles granted_role ON granted_role.oid=m.roleid
         WHERE member_role.rolname IN (${REQUIRED_ROLES.map(shellQuoteSql).join(",")})
            OR granted_role.rolname IN (${REQUIRED_ROLES.map(shellQuoteSql).join(",")});
      `),
    );
    if (
      Number(roleSummary.role_count) !== REQUIRED_ROLES.length ||
      Number(roleSummary.safe_role_count) !== REQUIRED_ROLES.length ||
      membershipCount !== 0
    ) {
      throw new Error("五个 capability role 的无登录/无特权/无成员关系不变量未成立。");
    }

    await runSql("CREATE ROLE gate_unprivileged NOLOGIN;");
    let aclTests;
    try {
      aclTests = await Promise.all([
        expectSqlState(
          "runtime-create-public",
          "BEGIN; SET ROLE app_runtime; CREATE TABLE public.gate_acl_probe(id integer); COMMIT;",
          "42501",
        ),
        expectSqlState(
          "runtime-update-iteration-tasks",
          "BEGIN; SET ROLE app_runtime; UPDATE public.iteration_tasks SET status=status; COMMIT;",
          "42501",
        ),
        expectSqlState(
          "runtime-read-release-items",
          "BEGIN; SET ROLE app_runtime; SELECT * FROM public.release_items LIMIT 1; COMMIT;",
          "42501",
        ),
        expectSqlState(
          "runtime-read-backing-view",
          "BEGIN; SET ROLE app_runtime; SELECT * FROM public.v_scripts_recommendable LIMIT 1; COMMIT;",
          "42501",
        ),
        expectSqlState(
          "content-worker-read-work-orders",
          "BEGIN; SET ROLE app_import_worker; SELECT * FROM public.work_order_import_batches LIMIT 1; COMMIT;",
          "42501",
        ),
        expectSqlState(
          "work-order-worker-read-content-imports",
          "BEGIN; SET ROLE app_work_order_worker; SELECT * FROM public.import_batches LIMIT 1; COMMIT;",
          "42501",
        ),
        expectSqlState(
          "content-worker-generic-outbox-complete",
          "BEGIN; SET ROLE app_import_worker; SELECT public.outbox_complete('job','worker',1,'done','hash'); COMMIT;",
          "42501",
        ),
        expectSqlState(
          "unprivileged-publish",
          "BEGIN; SET ROLE gate_unprivileged; SELECT public.publish_content_release('default','release','owner','owner','EVD-GATE'); COMMIT;",
          "42501",
        ),
      ]);
    } finally {
      await runSql("DROP ROLE IF EXISTS gate_unprivileged;");
    }
    const aclSideEffects = JSON.parse(
      await queryScalar(`SELECT json_build_object(
        'acl_probe_absent', to_regclass('public.gate_acl_probe') IS NULL,
        'raw_release_items_read', has_table_privilege('app_runtime','public.release_items','SELECT'),
        'backing_view_read', has_table_privilege('app_runtime','public.v_scripts_recommendable','SELECT'),
        'controlled_search_execute', has_function_privilege('app_runtime','public.search_recommendable_scripts(text,text,text)','EXECUTE')
      )::text;`),
    );
    if (
      aclSideEffects.acl_probe_absent !== true ||
      aclSideEffects.raw_release_items_read !== false ||
      aclSideEffects.backing_view_read !== false ||
      aclSideEffects.controlled_search_execute !== true
    ) {
      throw new Error("ACL 副作用/最小读边界校验失败。");
    }

    const announceAckDenialKey = `sda_${"a".repeat(64)}`;
    const announceAckActorHash = "b".repeat(64);
    const announceAckDiagnosticId = `diag_${"c".repeat(32)}`;
    const announceAckAuditCall = `SELECT public.record_runtime_source_denial_audit(
      ${shellQuoteSql(announceAckDenialKey)},'announce_ack','OFFLINE_LEASE_INVALID',
      ${shellQuoteSql(announceAckActorHash)},'hmac-v1','agent',NULL,NULL,NULL,
      ${shellQuoteSql(announceAckDiagnosticId)}
    );`;
    await runSql(`BEGIN; SET ROLE app_runtime; ${announceAckAuditCall} COMMIT;`);
    await runSql(`BEGIN; SET ROLE app_runtime; ${announceAckAuditCall} COMMIT;`);
    const announceAckAuditRows = Number(
      await queryScalar(
        `SELECT count(*) FROM public.source_denial_audits
          WHERE denial_key=${shellQuoteSql(announceAckDenialKey)}
            AND operation='announce_ack'
            AND reason_code='OFFLINE_LEASE_INVALID';`,
      ),
    );
    if (announceAckAuditRows !== 1) {
      throw new Error("announce_ack 来源/租约拒绝审计未通过 runtime wrapper 幂等持久化。");
    }
    const announceAckAuditMismatch = await expectSqlState(
      "announce-ack-denial-audit-idempotency-body-mismatch",
      `BEGIN; SET ROLE app_runtime; SELECT public.record_runtime_source_denial_audit(
        ${shellQuoteSql(announceAckDenialKey)},'announce_ack','OFFLINE_LEASE_EXPIRED',
        ${shellQuoteSql(announceAckActorHash)},'hmac-v1','agent',NULL,NULL,NULL,
        ${shellQuoteSql(announceAckDiagnosticId)}
      ); COMMIT;`,
      "ZA003",
    );

    const constraintTests = await Promise.all([
      expectSqlState(
        "invalid-app-user-role",
        "BEGIN; INSERT INTO public.app_users(user_id,role) VALUES ('gate-invalid-role','invalid'); COMMIT;",
        "23514",
      ),
      expectSqlState(
        "invalid-source-version-id",
        `BEGIN; INSERT INTO public.authoritative_source_versions(
          tenant_id,source_version_id,source_ref,domain,upstream_version,snapshot_sha256,use_class,
          owner_role,approval_evd,approved_by,approved_at,review_due_at
        ) VALUES (
          'default','invalid','SRC-GATE','presale','v1',repeat('a',64),'canonical',
          'ROLE-CONTENT-LEAD','EVD-GATE','USR-GATE',now(),now()
        ); COMMIT;`,
        "23514",
      ),
      expectSqlState(
        "invalid-privacy-notice-publish-shape",
        `BEGIN; INSERT INTO public.privacy_notices(notice_version,notice_text,content_hash,status,published_at)
          VALUES ('gate-invalid','notice',repeat('a',64),'current',NULL); COMMIT;`,
        "23514",
      ),
    ]);

    await runSql(
      "INSERT INTO public.app_users(user_id,role,display_name) VALUES ('gate-sentinel','system','preflight sentinel');",
    );
    const beforeRerunInventory = JSON.stringify(inventory);
    await runSqlFile(schemaPath);
    const sentinelRows = Number(
      await queryScalar("SELECT count(*) FROM public.app_users WHERE user_id='gate-sentinel';"),
    );
    const dangerousFlags = Number(
      await queryScalar(
        "SELECT count(*) FROM public.policy_flags WHERE flag_key IN ('rewrite','auto_send') AND flag_value IS DISTINCT FROM FALSE;",
      ),
    );
    const afterRerunInventory = JSON.parse(
      await queryScalar(`
        SELECT json_build_object(
          'tables', (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')),
          'views', (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v'),
          'functions', (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),
          'extensions', (SELECT json_object_agg(extname, extversion ORDER BY extname) FROM pg_catalog.pg_extension WHERE extname IN ('pgcrypto','pg_trgm'))
        )::text;
      `),
    );
    if (sentinelRows !== 1 || dangerousFlags !== 0 || JSON.stringify(afterRerunInventory) !== beforeRerunInventory) {
      throw new Error("完整 schema 二次执行未保持 sentinel/对象清单/一期危险开关不变量。");
    }

    const rollbackProbe = schema.replace(/\nCOMMIT;\s*$/, "\nSELECT 1 / 0;\nCOMMIT;\n");
    if (rollbackProbe === schema) throw new Error("无法在最终 COMMIT 前植入原子回滚故障。");
    await writeFile(rollbackSqlPath, rollbackProbe, { encoding: "utf8", mode: 0o600 });
    const rollbackResult = await runSqlFile(rollbackSqlPath, rollbackDb, true);
    const rollbackSqlState = sqlStateFrom(rollbackResult);
    if (rollbackResult.code === 0 || rollbackSqlState !== "22012") {
      throw new Error(`原子回滚故障未得到 SQLSTATE 22012，实际为 ${rollbackSqlState ?? rollbackResult.code}。`);
    }
    const rollbackState = JSON.parse(
      await queryScalar(
        `SELECT json_build_object(
          'public_relations', (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
          'public_functions', (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),
          'target_extensions', (SELECT count(*) FROM pg_catalog.pg_extension WHERE extname IN ('pgcrypto','pg_trgm')),
          'users_table_absent', to_regclass('public.app_users') IS NULL
        )::text;`,
        rollbackDb,
      ),
    );
    if (
      Number(rollbackState.public_relations) !== 0 ||
      Number(rollbackState.public_functions) !== 0 ||
      Number(rollbackState.target_extensions) !== 0 ||
      rollbackState.users_table_absent !== true
    ) {
      throw new Error("故障注入后留下部分 schema 副作用，原子回滚失败。");
    }

    const serverEncoding = await queryScalar("SHOW server_encoding;");
    const timezone = await queryScalar("SHOW timezone;");
    const schemaComment = await queryScalar(
      "SELECT COALESCE(obj_description('public'::regnamespace, 'pg_namespace'),'');",
    );
    const missingSchemaCommentFragments = ["schema.v1.12", ...REQUIRED_SCHEMA_COMMENT_FRAGMENTS].filter(
      (fragment) => !schemaComment.includes(fragment),
    );
    if (missingSchemaCommentFragments.length > 0) {
      throw new Error(
        `schema comment 未保留稳定证据边界：${missingSchemaCommentFragments.join("；")}`,
      );
    }

    successfulReport = {
      pgVersion,
      serverEncoding,
      timezone,
      inventory,
      roleSummary,
      membershipCount,
      aclTests,
      aclSideEffects,
      announceAckAuditRows,
      announceAckAuditMismatch,
      constraintTests,
      sentinelRows,
      dangerousFlags,
      rollbackState,
      rollbackSqlState,
    };
  } catch (error) {
    if (error?.result) {
      const detail = sanitize(error.result.stderr || error.result.stdout).trim().split("\n").slice(-8).join("\n");
      error.message = `${error.message}${detail ? `\n${detail}` : ""}`;
    }
    throw error;
  } finally {
    try {
      await cleanup();
    } finally {
      process.off("SIGINT", interruptHandler);
      process.off("SIGTERM", interruptHandler);
    }
  }

  if (!successfulReport) throw new Error("预检未产生完整报告。");

  const executedAt = new Date();
  const executedAtUtc = executedAt.toISOString();
  const executedAtShanghai = shanghaiIso(executedAt);
  const stamp = shanghaiStamp(executedAt);
  const evidenceId = `EVD-PG15-LOCAL-PREFLIGHT-${stamp}-${schemaSha.slice(0, 8).toUpperCase()}`;
  const roundName = `round-local-${stamp}-${randomBytes(3).toString("hex")}`;
  const finalDir = path.join(evidenceRoot, roundName);
  const stagingDir = `${finalDir}.partial`;
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  await mkdir(stagingDir, { recursive: false, mode: 0o700 });

  const checks = [
    { id: "schema-sha-lock", status: "PASS" },
    { id: "verifier-runner-integrity-recorded", status: "PASS" },
    { id: "postgresql-major-15", status: "PASS" },
    { id: "isolated-unix-socket-tcp-disabled", status: "PASS" },
    { id: "clean-install", status: "PASS" },
    { id: "object-extension-inventory", status: "PASS" },
    { id: "capability-role-safety", status: "PASS" },
    { id: "acl-negative-paths", status: "PASS", cases: successfulReport.aclTests.length },
    { id: "announce-ack-source-denial-wrapper", status: "PASS", cases: 3 },
    { id: "constraint-negative-paths", status: "PASS", cases: successfulReport.constraintTests.length },
    { id: "idempotent-rerun", status: "PASS" },
    { id: "atomic-rollback", status: "PASS" },
    { id: "temporary-cluster-destroyed", status: "PASS" },
    { id: "prior-version-upgrade", status: "NOT_CERTIFIED" },
    { id: "migration-runtime-managed-production", status: "NOT_CERTIFIED" },
  ];
  const results = {
    gate: `${PROJECT_CODE}-PG15-REFERENCE-PREFLIGHT`,
    evidence_id: evidenceId,
    executed_at: executedAtUtc,
    executed_at_utc: executedAtUtc,
    executed_at_asia_shanghai: executedAtShanghai,
    runner: {
      name: "verify_customer_agent_pg15.mjs",
      version: VERIFIER_VERSION,
      sha256: verifierSha,
      node: process.version,
    },
    schema: { version: "v1.12", sha256: schemaSha },
    environment: {
      postgresql: successfulReport.pgVersion,
      encoding: successfulReport.serverEncoding,
      timezone: successfulReport.timezone,
      transport: "isolated Unix socket only; TCP disabled",
      database: "ephemeral randomized gate databases",
      cluster: "temporary; stopped and destroyed after checks",
      credentials: "no password, connection string, PGDATA, WAL or dump persisted",
    },
    inventory: successfulReport.inventory,
    checks,
    overall: "PASS_WITH_LIMITATION",
    certified: ["current schema.v1.12 clean-install reference DDL preflight on isolated PostgreSQL 15"],
    not_certified: [
      "immutable migration chain or N/N-1 upgrade",
      "application runtime, API, worker or Electron behavior",
      "managed PostgreSQL or production deployment",
      "backup/restore, PITR, concurrency/deadlock, load or disaster recovery",
    ],
    governance: {
      g0_pass_count_changed: false,
      scope_pass_count_changed: false,
      ddev_authorized: false,
    },
  };

  const aclLines = successfulReport.aclTests.map(
    (test) => `${test.id}=PASS SQLSTATE ${test.observed_sqlstate}`,
  );
  const constraintLines = successfulReport.constraintTests.map(
    (test) => `${test.id}=PASS SQLSTATE ${test.observed_sqlstate}`,
  );
  const files = new Map([
    ["results.json", `${JSON.stringify(results, null, 2)}\n`],
    [
      "README.md",
      [
        `# ${PROJECT_CODE} PostgreSQL 15 reference DDL 隔离预检`,
        "",
        `- 证据 ID：\`${evidenceId}\``,
        `- 执行时间（UTC）：${executedAtUtc}`,
        `- 执行时间（Asia/Shanghai）：${executedAtShanghai}`,
        `- 预检器：\`verify_customer_agent_pg15.mjs\` v${VERIFIER_VERSION} / SHA-256 \`${verifierSha}\``,
        `- schema：\`v1.12\` / SHA-256 \`${schemaSha}\``,
        `- PostgreSQL：${successfulReport.pgVersion}`,
        "- 总结论：**PASS-WITH-LIMITATION**",
        "- 已通过：当前 reference DDL clean install、对象/扩展/角色、ACL 与约束负例、完整二次执行保留数据、COMMIT 前故障的事务原子回滚",
        "- 隔离：临时 cluster + 私有 Unix socket，TCP 禁用；结束时已停库并删除 PGDATA/WAL",
        "- 未保存：密码、连接串、PGDATA、WAL、dump、客户原文或 PII",
        "",
        "## 严格边界",
        "",
        "本证据只证明当前 schema.v1.12 clean-install reference DDL 在本机隔离 PostgreSQL 15 的设计前置预检。它不证明 migration、N/N-1、runtime、托管 PG、备份恢复、并发/死锁、压测或生产就绪，不自动修改 G0/Scope/Ddev。",
        "",
      ].join("\n"),
    ],
    [
      "runner-integrity.txt",
      [
        "status=PASS",
        "runner=verify_customer_agent_pg15.mjs",
        `version=${VERIFIER_VERSION}`,
        `sha256=${verifierSha}`,
        `node=${process.version}`,
        "",
      ].join("\n"),
    ],
    [
      "environment.txt",
      [
        `postgresql=${successfulReport.pgVersion}`,
        `server_encoding=${successfulReport.serverEncoding}`,
        `timezone=${successfulReport.timezone}`,
        "transport=isolated Unix socket only; TCP disabled",
        "port=random high port; value not persisted",
        "database=ephemeral randomized gate databases",
        "cluster_cleanup=PASS; PGDATA and WAL destroyed",
        "credentials=no password or connection string persisted",
        "",
      ].join("\n"),
    ],
    [
      "schema-integrity.txt",
      [
        "status=PASS",
        "schema=business-docs/01-客服Agent项目/20-设计-进行中/33-schema-v1-草案.sql",
        "version=v1.12",
        `sha256=${schemaSha}`,
        "dialect=PostgreSQL 15+",
        "purpose=clean-install reference DDL preflight only",
        "",
      ].join("\n"),
    ],
    [
      "clean-install.txt",
      [
        "status=PASS",
        "transaction=COMMIT",
        `tables=${successfulReport.inventory.tables}`,
        `views=${successfulReport.inventory.views}`,
        `functions=${successfulReport.inventory.functions}`,
        `pgcrypto=${successfulReport.inventory.extensions.pgcrypto}`,
        `pg_trgm=${successfulReport.inventory.extensions.pg_trgm}`,
        `capability_roles=${successfulReport.roleSummary.role_count}`,
        `safe_capability_roles=${successfulReport.roleSummary.safe_role_count}`,
        `capability_memberships=${successfulReport.membershipCount}`,
        "",
      ].join("\n"),
    ],
    [
      "acl-negative-tests.txt",
      [
        "status=PASS",
        ...aclLines,
        `acl_probe_absent=${successfulReport.aclSideEffects.acl_probe_absent}`,
        `runtime_raw_release_items_read=${successfulReport.aclSideEffects.raw_release_items_read}`,
        `runtime_backing_view_read=${successfulReport.aclSideEffects.backing_view_read}`,
        `runtime_controlled_search_execute=${successfulReport.aclSideEffects.controlled_search_execute}`,
        `announce_ack_denial_audit_rows=${successfulReport.announceAckAuditRows}`,
        `announce_ack_denial_audit_mismatch=${successfulReport.announceAckAuditMismatch.observed_sqlstate}`,
        "",
      ].join("\n"),
    ],
    [
      "constraint-negative-tests.txt",
      ["status=PASS", ...constraintLines, "failed_rows_persisted=0", ""].join("\n"),
    ],
    [
      "idempotent-rerun.txt",
      [
        "status=PASS",
        "method=run the complete current schema a second time",
        `sentinel_rows_after_rerun=${successfulReport.sentinelRows}`,
        `dangerous_phase1_flags_enabled=${successfulReport.dangerousFlags}`,
        "object_inventory_unchanged=true",
        "",
      ].join("\n"),
    ],
    [
      "atomic-rollback.txt",
      [
        "status=PASS",
        "method=inject division-by-zero immediately before final COMMIT in an ephemeral copy",
        `sqlstate=${successfulReport.rollbackSqlState}`,
        `post_failure_public_relations=${successfulReport.rollbackState.public_relations}`,
        `post_failure_public_functions=${successfulReport.rollbackState.public_functions}`,
        `post_failure_target_extensions=${successfulReport.rollbackState.target_extensions}`,
        `post_failure_users_table_absent=${successfulReport.rollbackState.users_table_absent}`,
        "",
      ].join("\n"),
    ],
    [
      "upgrade-boundary.txt",
      [
        "status=NOT_CERTIFIED",
        "reason=no immutable migration artifact or prior signed release baseline exists before Ddev/DEV-M0",
        "verified_now=current schema.v1.12 clean-install reference DDL preflight only",
        "not_verified=expand/backfill/validate/contract, N/N-1, runtime, managed PG, backup/restore, production",
        "ddev_authorized=false",
        "g0_scope_counts_changed=false",
        "",
      ].join("\n"),
    ],
  ]);

  for (const [name, content] of files) {
    await writeFile(path.join(stagingDir, name), content, { encoding: "utf8", mode: 0o600 });
  }
  await rename(stagingDir, finalDir);

  console.log(
    JSON.stringify({
      ok: true,
      evidenceId,
      evidencePath: path.relative(repoRoot, finalDir),
      schemaSha256: schemaSha,
      verifierVersion: VERIFIER_VERSION,
      verifierSha256: verifierSha,
      postgresql: successfulReport.pgVersion,
      overall: "PASS_WITH_LIMITATION",
      ddevAuthorized: false,
    }),
  );
}

main().catch((error) => {
  console.error(`PG15 reference DDL 预检失败：${error.message}`);
  process.exitCode = 1;
});
