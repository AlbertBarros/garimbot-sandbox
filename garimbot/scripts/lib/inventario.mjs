// Inventário de IA e análise de alcance (8.14, item 11), SÓ LEITURA: o que de
// IA cada projeto usa (bibliotecas, modelos, MCPs, skills, agentes e NOMES das
// chaves — nunca os valores) e quais dependências com falha são importadas de
// verdade no código (prioridade) e quais não.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const IGNORAR = new Set(["node_modules", ".git", "dist", "build", ".next", ".wrangler", "coverage", ".garimbot", "outputs", "work", "venv", ".venv"]);
const CODIGO = /\.(m?[jt]sx?|cjs|py|vue|svelte)$/i;
const SDKS = ["openai", "@anthropic-ai/sdk", "@google/generative-ai", "@google/genai", "langchain", "@langchain/core", "ai", "@ai-sdk/openai", "@ai-sdk/anthropic", "replicate", "groq-sdk", "@mistralai/mistralai", "ollama", "@huggingface/inference", "@modelcontextprotocol/sdk", "anthropic", "transformers", "google-generativeai"];
const MODELOS = /\b(claude-(?:opus|sonnet|haiku|fable|[0-9])[a-z0-9.-]*|gpt-[0-9][a-z0-9.-]*|gpt-4o[a-z0-9.-]*|o[134](?:-mini|-pro)?\b|gemini-[0-9][a-z0-9.-]*|llama-?[0-9][a-z0-9.-]*|whisper-[0-9a-z-]+)/gi;
const CHAVES = /(?:process\.env|env|os\.environ(?:\.get)?|Deno\.env\.get)\s*[.[(]\s*["']?([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|SENHA)[A-Z0-9_]*)/g;

async function arquivos(raiz, max = 4000) {
  const out = [];
  async function andar(rel) {
    if (out.length >= max) return;
    for (const e of await readdir(path.join(raiz, rel), { withFileTypes: true }).catch(() => [])) {
      if (IGNORAR.has(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) await andar(r);
      else if (e.isFile()) out.push(r);
    }
  }
  await andar("");
  return out;
}
const importa = (texto, pkg) => new RegExp(`(from\\s+["']${pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(/[^"']*)?["']|require\\(\\s*["']${pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(/[^"']*)?["']\\s*\\)|^\\s*(import|from)\\s+${pkg.replace(/-/g, "_").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b)`, "m").test(texto);

export async function inventarioIa(raiz, { vulneraveis = [] } = {}) {
  const lista = await arquivos(raiz);
  const inv = { sdks: new Set(), modelos: new Set(), chaves: new Set(), mcps: [], skills: [], agentes: [], hooks: false };
  const usados = new Set();
  const nomesVuln = [...new Set(vulneraveis.map((v) => v.split("@").slice(0, v.startsWith("@") ? 2 : 1).join("@")))];
  for (const rel of lista) {
    if (/(^|\/)\.mcp\.json$/.test(rel)) {
      const j = JSON.parse(await readFile(path.join(raiz, rel), "utf8").catch(() => "{}"));
      inv.mcps.push(...Object.keys(j.mcpServers ?? {}).map((n) => `${n} (${rel})`));
    }
    if (/(^|\/)\.claude\/skills\/[^/]+\/SKILL\.md$/.test(rel)) inv.skills.push(rel.split("/").slice(-2)[0]);
    if (/(^|\/)\.claude\/agents\/[^/]+\.md$/.test(rel)) inv.agentes.push(path.basename(rel, ".md"));
    if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(rel)) inv.hooks ||= /"hooks"\s*:/.test(await readFile(path.join(raiz, rel), "utf8").catch(() => ""));
    if (!CODIGO.test(rel)) continue;
    if ((await stat(path.join(raiz, rel))).size > 1e6) continue;
    const t = await readFile(path.join(raiz, rel), "utf8").catch(() => "");
    for (const s of SDKS) if (importa(t, s)) inv.sdks.add(s);
    for (const m of t.match(MODELOS) ?? []) inv.modelos.add(m.toLowerCase());
    for (const m of t.matchAll(CHAVES)) inv.chaves.add(m[1]);
    for (const n of nomesVuln) if (!usados.has(n) && importa(t, n)) usados.add(n);
  }
  return {
    sdks: [...inv.sdks].sort(),
    modelos: [...inv.modelos].sort().slice(0, 50),
    chaves: [...inv.chaves].sort(),
    mcps: inv.mcps,
    skills: inv.skills.sort(),
    agentes: inv.agentes.sort(),
    hooks: inv.hooks,
    // alcance: dependência com falha importada no código = prioridade
    alcance: nomesVuln.map((n) => ({ pacote: n, usado_no_codigo: usados.has(n) })),
  };
}
