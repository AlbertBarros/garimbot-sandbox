// Ferramentas externas do Garimbot (rodam no sandbox, sem credenciais e sem
// shell): Gitleaks (segredos, histórico inteiro), OSV-Scanner ou a API do OSV
// (dependências), Semgrep e GuardDog (extras). Ferramenta que não roda ou
// falha = verificação não concluída = REPROVA (quem decide é o veredito).
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// roda um programa sem shell, com tempo máximo e ambiente limpo (sem segredos)
export function rodar(cmd, args, { cwd, timeoutMs = 10 * 60e3, env = {} } = {}) {
  return new Promise((resolve) => {
    let out = "",
      err = "";
    const limpo = {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? os.homedir(),
      ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.HTTPS_PROXY } : {}),
      ...Object.fromEntries(["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "NO_PROXY", "no_proxy"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
      ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
      // Windows precisa destas para o git e o node funcionarem (nenhuma é segredo)
      ...Object.fromEntries(["USERPROFILE", "SystemRoot", "TEMP", "TMP", "PATHEXT", "ComSpec"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      ...env,
    };
    let filho;
    try {
      filho = spawn(cmd, args, { cwd, env: limpo, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ codigo: -1, out: "", err: String(e.message) });
    }
    const t = setTimeout(() => filho.kill("SIGKILL"), timeoutMs);
    filho.stdout.on("data", (d) => (out += d).length > 5e7 && filho.kill("SIGKILL"));
    filho.stderr.on("data", (d) => (err = (err + d).slice(-20000)));
    filho.on("error", (e) => {
      clearTimeout(t);
      resolve({ codigo: -1, out, err: String(e.message) });
    });
    filho.on("close", (codigo, sinal) => {
      clearTimeout(t);
      resolve({ codigo: sinal ? -1 : codigo, out, err });
    });
  });
}
// sem checagem de versão nem métricas do Semgrep (não manda nada para fora)
const SEMGREP_ENV = { SEMGREP_ENABLE_VERSION_CHECK: "0", SEMGREP_SEND_METRICS: "off" };
export async function disponivel(cmd) {
  const r = await rodar(cmd, ["--version"], { timeoutMs: 60e3, env: SEMGREP_ENV });
  return r.codigo === 0;
}

// ---------- Gitleaks: segredos no código e em todo o histórico ----------
export async function gitleaks(dir) {
  if (!(await disponivel("gitleaks"))) return { ok: false, erro: "gitleaks não instalado" };
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gl-"));
  try {
    const rel = path.join(tmp, "r.json");
    // pacote baixado (sem .git): confere só os arquivos
    const semGit = existsSync(path.join(dir, ".git")) ? [] : ["--no-git"];
    const r = await rodar("gitleaks", ["detect", "--source", dir, ...semGit, "--report-format", "json", "--report-path", rel, "--no-banner", "--redact", "--exit-code", "2"], { timeoutMs: 15 * 60e3 });
    if (![0, 2].includes(r.codigo)) return { ok: false, erro: "gitleaks falhou: " + r.err.slice(-300) };
    const lista = JSON.parse((await readFile(rel, "utf8").catch(() => "[]")) || "[]");
    return {
      ok: true,
      achados: lista.slice(0, 50).map((l) => ({
        nivel: "bloqueio",
        regra: "segredo-vazado",
        arquivo: l.File,
        linha: l.StartLine ?? null,
        detalhe: `${l.RuleID ?? "segredo"} no commit ${String(l.Commit ?? "").slice(0, 10)} (valor oculto)`,
      })),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------- dependências ----------
// pacotes muito usados (para pegar nomes imitados nas dependências)
export const POPULARES_NPM = [
  "react", "react-dom", "next", "vite", "express", "lodash", "axios", "chalk", "commander", "debug",
  "dotenv", "typescript", "webpack", "eslint", "prettier", "jest", "vitest", "zod", "moment", "dayjs",
  "uuid", "yargs", "inquirer", "request", "node-fetch", "cross-env", "tailwindcss", "firebase",
  "firebase-admin", "@anthropic-ai/sdk", "openai", "ws", "socket.io", "mongoose", "pg", "mysql2",
  "sharp", "puppeteer", "playwright", "electron", "colors", "minimist", "semver", "glob", "rimraf",
  "body-parser", "cors", "jsonwebtoken", "bcrypt", "nodemailer", "twilio", "stripe", "remotion",
];
export const POPULARES_PY = ["requests", "numpy", "pandas", "flask", "django", "fastapi", "urllib3", "openai", "anthropic", "pillow", "boto3", "pyyaml", "cryptography", "selenium", "beautifulsoup4", "scipy", "torch", "transformers"];
export function parecido(nome, lista) {
  const n = nome.toLowerCase();
  if (lista.includes(n)) return null;
  for (const p of lista) {
    if (Math.abs(p.length - n.length) > 2 || p.length < 4) continue;
    let d = 0;
    const a = n,
      b = p;
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    d = m[a.length][b.length];
    if (d > 0 && d <= (p.length >= 7 ? 2 : 1)) return p;
  }
  return null;
}
const versaoBase = (v) => /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(String(v))?.[1] ?? null;
async function lerJsonSeguro(f) {
  try {
    return JSON.parse(await readFile(f, "utf8"));
  } catch {
    return null;
  }
}
// pacotes declarados (npm e PyPI) com a versão fixa do lock quando houver
export async function declaradas(dir) {
  const pacotes = [];
  const pj = await lerJsonSeguro(path.join(dir, "package.json"));
  const lock = await lerJsonSeguro(path.join(dir, "package-lock.json"));
  if (pj) {
    const todas = { ...pj.dependencies, ...pj.optionalDependencies, ...pj.peerDependencies, ...pj.devDependencies };
    for (const [nome, faixa] of Object.entries(todas)) {
      const fixa = lock?.packages?.["node_modules/" + nome]?.version ?? lock?.dependencies?.[nome]?.version;
      pacotes.push({ ecossistema: "npm", nome, versao: fixa ?? versaoBase(faixa), fixa: Boolean(fixa) });
    }
  }
  for (const req of ["requirements.txt", "requirements-dev.txt"]) {
    const f = path.join(dir, req);
    if (!existsSync(f)) continue;
    for (const linha of (await readFile(f, "utf8")).split("\n")) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*(==|>=|~=)?\s*([\w.]+)?/.exec(linha.replace(/#.*/, ""));
      if (m?.[1] && !linha.trim().startsWith("-"))
        pacotes.push({ ecossistema: "PyPI", nome: m[1], versao: m[3] ?? null, fixa: m[2] === "==" });
    }
  }
  return pacotes;
}
const OUTROS_LOCKS = ["go.sum", "Cargo.lock", "Gemfile.lock", "composer.lock", "poetry.lock", "Pipfile.lock", "pnpm-lock.yaml", "yarn.lock", "pom.xml", "build.gradle", "packages.lock.json", "uv.lock"];
// vulnerabilidades conhecidas: osv-scanner (todos os ecossistemas) ou a API do OSV (npm/PyPI)
// `proprio`: o próprio pacote auditado (porteiro), conferido também na base de falhas
export async function dependencias(dir, { fetcher = fetch, osvCli = null, proprio = null } = {}) {
  const achados = [];
  const pacotes = [...(await declaradas(dir)), ...(proprio ? [{ ...proprio, fixa: false, proprio: true }] : [])];
  for (const p of pacotes.filter((x) => !x.proprio)) {
    const imita = parecido(p.nome, p.ecossistema === "npm" ? POPULARES_NPM : POPULARES_PY);
    if (imita) achados.push({ nivel: "bloqueio", regra: "dependencia-imitada", arquivo: p.ecossistema === "npm" ? "package.json" : "requirements.txt", detalhe: `"${p.nome}" parece imitar "${imita}"` });
  }
  const outros = (await readdir(dir)).filter((f) => OUTROS_LOCKS.includes(f));
  const usarCli = osvCli ?? (await disponivel("osv-scanner"));
  if (usarCli) {
    // osv-scanner 1.9.x (versão fixada no sandbox). GARIMBOT_OSV_OFFLINE=1 usa a base baixada
    // do Google Storage quando a API do OSV não responde (o resultado é o mesmo banco).
    const offline = process.env.GARIMBOT_OSV_OFFLINE === "1" ? ["--experimental-offline-vulnerabilities", "--experimental-download-offline-databases"] : [];
    const lerSaida = (r) => {
      // 0 = sem vulnerabilidade, 1 = achou, 128 = nada para analisar
      if (![0, 1, 128].includes(r.codigo)) throw new Error("osv-scanner falhou: " + r.err.slice(-300));
      try {
        return JSON.parse(r.out || '{"results":[]}');
      } catch {
        throw new Error("saída do osv-scanner ilegível");
      }
    };
    const anotar = (d, origem) => {
      for (const res of d.results ?? [])
        for (const pk of res.packages ?? [])
          for (const v of (pk.vulnerabilities ?? []).slice(0, 5))
            achados.push({ nivel: "bloqueio", regra: "dependencia-vulneravel", arquivo: origem ?? res.source?.path?.replace(dir, "") ?? "", detalhe: `${pk.package?.name}@${pk.package?.version}: ${v.id} ${String(v.summary ?? "").slice(0, 120)}` });
    };
    const tmp = await mkdtemp(path.join(os.tmpdir(), "osv-"));
    try {
      anotar(lerSaida(await rodar("osv-scanner", ["scan", "--recursive", "--skip-git", "--format", "json", ...offline, dir], { timeoutMs: 10 * 60e3 })));
      // dependências do package.json/requirements sem lock: confere a versão mínima declarada (SBOM)
      const soltas = pacotes.filter((p) => !p.fixa && p.versao);
      if (soltas.length) {
        const sbom = path.join(tmp, "garimbot.cdx.json");
        const purl = (p) => (p.ecossistema === "npm" ? "pkg:npm/" + p.nome.replace("@", "%40") : "pkg:pypi/" + p.nome.toLowerCase()) + "@" + p.versao;
        await writeFile(sbom, JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.4", version: 1, components: soltas.map((p) => ({ type: "library", name: p.nome, version: p.versao, purl: purl(p) })) }));
        anotar(lerSaida(await rodar("osv-scanner", ["scan", "--format", "json", ...offline, "--sbom", sbom], { timeoutMs: 10 * 60e3 })), "package.json/requirements (versão declarada)");
      }
    } catch (e) {
      return { ok: false, erro: e.message, achados };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    for (const p of pacotes.filter((p) => !p.versao)) achados.push({ nivel: "revisar", regra: "dependencia-sem-versao", arquivo: "", detalhe: `${p.nome} sem versão definida` });
    return { ok: true, achados, pacotes: pacotes.length, metodo: "osv-scanner" + (offline.length ? " (base offline)" : "") };
  }
  if (outros.length) return { ok: false, erro: `dependências em ${outros.join(", ")} precisam do osv-scanner`, achados };
  const consultar = pacotes.filter((p) => p.versao);
  const semVersao = pacotes.filter((p) => !p.versao);
  for (const p of semVersao) achados.push({ nivel: "revisar", regra: "dependencia-sem-versao", arquivo: "", detalhe: `${p.nome} sem versão definida` });
  if (!consultar.length) return { ok: true, achados, pacotes: 0, metodo: "nenhuma dependência" };
  let r;
  try {
    r = await fetcher("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: consultar.map((p) => ({ package: { ecosystem: p.ecossistema, name: p.nome }, version: p.versao })) }),
    });
  } catch (e) {
    return { ok: false, erro: "API do OSV fora do ar: " + e.message, achados };
  }
  if (!r.ok) return { ok: false, erro: "API do OSV respondeu " + r.status, achados };
  const d = await r.json();
  (d.results ?? []).forEach((res, i) => {
    for (const v of (res.vulns ?? []).slice(0, 5))
      achados.push({ nivel: "bloqueio", regra: "dependencia-vulneravel", arquivo: "", detalhe: `${consultar[i].nome}@${consultar[i].versao}: ${v.id}` });
  });
  return { ok: true, achados, pacotes: consultar.length, metodo: "api do OSV" };
}

// ---------- extras (sandbox) ----------
export async function semgrep(dir) {
  if (!(await disponivel("semgrep"))) return { ok: false, erro: "semgrep não instalado" };
  const r = await rodar("semgrep", ["scan", "--config", "p/security-audit", "--config", "p/secrets", "--json", "--metrics=off", "--quiet", "--timeout", "30", dir], { timeoutMs: 20 * 60e3, env: SEMGREP_ENV });
  if (![0, 1].includes(r.codigo)) return { ok: false, erro: "semgrep falhou: " + r.err.slice(-300) };
  let d;
  try {
    d = JSON.parse(r.out);
  } catch {
    return { ok: false, erro: "saída do semgrep ilegível" };
  }
  return {
    ok: true,
    achados: (d.results ?? [])
      .filter((x) => ["ERROR", "WARNING"].includes(x.extra?.severity))
      .slice(0, 40)
      .map((x) => ({ nivel: x.extra.severity === "ERROR" ? "bloqueio" : "revisar", regra: "semgrep:" + x.check_id.split(".").pop(), arquivo: x.path.replace(dir + "/", ""), linha: x.start?.line ?? null, detalhe: String(x.extra?.message ?? "").slice(0, 200) })),
  };
}
export async function guarddog(dir) {
  if (!(await disponivel("guarddog"))) return { ok: false, erro: "guarddog não instalado" };
  const eco = existsSync(path.join(dir, "package.json")) ? "npm" : existsSync(path.join(dir, "setup.py")) || existsSync(path.join(dir, "pyproject.toml")) ? "pypi" : null;
  if (!eco) return { ok: true, achados: [], nota: "sem pacote npm/PyPI" };
  const r = await rodar("guarddog", [eco, "scan", dir, "--output-format", "json"], { timeoutMs: 15 * 60e3, env: SEMGREP_ENV });
  if (r.codigo !== 0) return { ok: false, erro: "guarddog falhou: " + r.err.slice(-300) };
  let d;
  try {
    d = JSON.parse(r.out);
  } catch {
    return { ok: false, erro: "saída do guarddog ilegível" };
  }
  const achados = [];
  for (const [regra, res] of Object.entries(d.results ?? {}))
    if (res && (Array.isArray(res) ? res.length : typeof res === "object" ? Object.keys(res).length : res))
      achados.push({ nivel: "bloqueio", regra: "guarddog:" + regra, arquivo: "", detalhe: JSON.stringify(res).slice(0, 200) });
  return { ok: true, achados };
}
