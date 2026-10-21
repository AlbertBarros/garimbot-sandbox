// Teste do MCP funcionando (8.14, item 7) — SÓ NO SANDBOX: inicia o servidor,
// lista as ferramentas e procura descrições envenenadas (ordens escondidas
// para a IA) e combinações perigosas entre ferramentas.
import { spawn } from "node:child_process";
import { INJECAO, BIDI, TAGS, INVISIVEIS } from "./scanner.mjs";

const ESCONDIDO = /<\s*(important|system|secret|instructions?)\s*>|before (using|calling) (this|any) tool|do not (tell|mention|inform)|n[aã]o (conte|mencione|avise)|ignore (the )?(user|previous)|always (call|use) this tool first|~\/\.ssh|\.env\b|id_rsa|mcp\.json/i;
const LE_LOCAL = /\b(read[_ -]?file|file[_ -]?system|filesystem|list[_ -]?dir|shell|exec(ute)?|run[_ -]?command|terminal|env(ironment)?|credentials?|clipboard)\b/i;
const MANDA_FORA = /\b(fetch|http|url|webhook|send|post|upload|email|e-mail|slack|discord|telegram|request)\b/i;

export function analisarFerramentas(tools = []) {
  const achados = [];
  for (const t of tools) {
    const texto = [t.name, t.description, JSON.stringify(t.inputSchema ?? {})].join("\n");
    if (INJECAO.test(texto) || ESCONDIDO.test(texto)) achados.push({ nivel: "bloqueio", regra: "descricao-envenenada", ferramenta: t.name, detalhe: String(t.description ?? "").slice(0, 200) });
    if (BIDI.test(texto) || TAGS.test(texto) || INVISIVEIS.test(texto)) achados.push({ nivel: "bloqueio", regra: "unicode-escondido", ferramenta: t.name, detalhe: "caracteres invisíveis na descrição" });
    if (String(t.description ?? "").length > 2000) achados.push({ nivel: "revisar", regra: "descricao-longa", ferramenta: t.name, detalhe: "descrição muito longa (pode esconder ordens)" });
  }
  const leitoras = tools.filter((t) => LE_LOCAL.test(`${t.name} ${t.description}`)).map((t) => t.name);
  const envia = tools.filter((t) => MANDA_FORA.test(`${t.name} ${t.description}`)).map((t) => t.name);
  if (leitoras.length && envia.length)
    achados.push({ nivel: "revisar", regra: "combinacao-perigosa", ferramenta: [...leitoras, ...envia].join(", "), detalhe: `lê o computador (${leitoras.join(", ")}) e manda para fora (${envia.join(", ")}): juntas, podem vazar dados` });
  return { ferramentas: tools.map((t) => t.name), achados };
}

// conversa com o servidor MCP por stdio: initialize → tools/list (tempo máximo)
export function listarFerramentas(comando, args = [], { timeoutMs = 30e3, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(comando, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "" } });
    let buf = "";
    const fim = (fn, v) => {
      clearTimeout(t);
      p.kill("SIGKILL");
      fn(v);
    };
    const t = setTimeout(() => fim(reject, new Error("o servidor MCP não respondeu a tempo")), timeoutMs);
    const enviar = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    p.on("error", (e) => fim(reject, e));
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const linha = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!linha) continue;
        let m;
        try {
          m = JSON.parse(linha);
        } catch {
          continue;
        }
        if (m.id === 1) {
          enviar({ method: "notifications/initialized" });
          enviar({ id: 2, method: "tools/list", params: {} });
        } else if (m.id === 2) fim(resolve, m.result?.tools ?? []);
      }
    });
    enviar({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "garimbot", version: "1" } } });
  });
}
