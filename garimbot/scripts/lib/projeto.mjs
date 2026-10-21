// Fase 3: auditoria de um projeto do dono, SÓ LEITURA. Confere as
// dependências já declaradas/instaladas (falhas conhecidas, nomes imitados,
// pacotes com script de instalação) e quais ainda não passaram pelo Garimbot.
// Nunca altera, instala ou executa nada na pasta do projeto.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { dependencias } from "./ferramentas.mjs";
import { lerAprovados } from "./guard.mjs";
import { inventarioIa } from "./inventario.mjs";

async function lerJsonSeguro(f) {
  try {
    return JSON.parse(await readFile(f, "utf8"));
  } catch {
    return null;
  }
}

export async function auditarProjeto(pasta, { aprovadosArq, fetcher } = {}) {
  if (!existsSync(pasta)) throw new Error("Pasta não encontrada: " + pasta);
  const lock = await lerJsonSeguro(path.join(pasta, "package-lock.json"));
  const pj = await lerJsonSeguro(path.join(pasta, "package.json"));
  const temRequirements = existsSync(path.join(pasta, "requirements.txt"));
  if (!lock && !pj && !temRequirements) throw new Error("Não achei package.json, package-lock.json nem requirements.txt nessa pasta.");
  // pacotes do lock que rodam script ao instalar (npm marca "hasInstallScript")
  const comScript = Object.entries(lock?.packages ?? {})
    .filter(([k, v]) => k && v?.hasInstallScript)
    .map(([k, v]) => `${k.replace(/^.*node_modules\//, "")}@${v.version}`);
  const d = await dependencias(pasta, { fetcher });
  const diretas = Object.entries({ ...pj?.dependencies, ...pj?.devDependencies }).map(([nome, faixa]) => ({
    nome,
    versao: lock?.packages?.["node_modules/" + nome]?.version ?? String(faixa),
  }));
  const ap = await lerAprovados(aprovadosArq);
  const aprovado = (n, v) => ap.itens.some((i) => i.tipo === "npm" && i.nome === n && i.versao === v);
  const falhas = d.achados.filter((a) => a.regra === "dependencia-vulneravel");
  const inv = await inventarioIa(pasta, { vulneraveis: falhas.map((f) => f.detalhe.split(":")[0]) });
  return {
    pasta,
    inventario: inv,
    nome: pj?.name ?? path.basename(pasta),
    verificacao: d.ok ? d.metodo : "não concluída: " + d.erro,
    falhas: d.achados.filter((a) => a.regra === "dependencia-vulneravel"),
    imitados: d.achados.filter((a) => a.regra === "dependencia-imitada"),
    com_script_de_instalacao: comScript,
    sem_lock: Boolean(pj && !lock),
    diretas: diretas.length,
    nao_auditadas: diretas.filter((x) => !aprovado(x.nome, x.versao)).map((x) => `${x.nome}@${x.versao}`),
  };
}

export function projetoMd(r, agora = new Date()) {
  const L = [`# Garimbot · auditoria do projeto ${r.nome}`, "", `${agora.toISOString().slice(0, 10).split("-").reverse().join("/")} · só leitura (nada foi alterado, instalado ou executado) · dependências: ${r.verificacao}`, ""];
  const completo = !r.verificacao.startsWith("não concluída");
  if (!completo) L.push("> ⚠ A verificação de falhas não terminou (sem internet ou sem ferramenta).", "");
  L.push(r.falhas.length ? `## ❌ ${r.falhas.length} dependência(s) com falha conhecida` : "## ✅ Nenhuma dependência com falha conhecida", "");
  // alcance: primeiro o que o código importa de verdade
  const usados = new Set((r.inventario?.alcance ?? []).filter((a) => a.usado_no_codigo).map((a) => a.pacote));
  const nomeDe = (f) => { const s = f.detalhe.split(":")[0]; return s.split("@").slice(0, s.startsWith("@") ? 2 : 1).join("@"); };
  const ordem = [...r.falhas].sort((a, b) => usados.has(nomeDe(b)) - usados.has(nomeDe(a)));
  if (r.falhas.length) L.push(`Prioridade: ${usados.size} pacote(s) com falha são importados direto no código (marcados com 🔴); os outros vêm de dependências ou ferramentas.`, "");
  for (const f of ordem.slice(0, 40)) L.push(`- ${usados.has(nomeDe(f)) ? "🔴 " : ""}${f.detalhe}`);
  if (r.imitados.length) L.push("", "## ⚠ Nomes que imitam pacotes famosos", "", ...r.imitados.map((f) => "- " + f.detalhe));
  if (r.com_script_de_instalacao.length) L.push("", `## ⚠ ${r.com_script_de_instalacao.length} pacote(s) rodam script ao instalar`, "", "Instale com `npm ci --ignore-scripts` quando der; confira se cada um precisa mesmo do script.", "", ...r.com_script_de_instalacao.slice(0, 40).map((x) => "- " + x));
  if (r.sem_lock) L.push("", "## ⚠ Sem package-lock.json", "", "Sem o lock, cada instalação pode trazer versões diferentes. Rode `npm install` uma vez e versione o `package-lock.json`.");
  const inv = r.inventario;
  if (inv) {
    L.push("", "## Inventário de IA (só nomes; nenhum valor de chave é lido)", "");
    L.push(`- Bibliotecas de IA: ${inv.sdks.join(", ") || "nenhuma"}`);
    L.push(`- Modelos citados no código: ${inv.modelos.join(", ") || "nenhum"}`);
    L.push(`- Chaves usadas (nomes): ${inv.chaves.join(", ") || "nenhuma"}`);
    L.push(`- Servidores MCP: ${inv.mcps.join(", ") || "nenhum"} · skills: ${inv.skills.length} · agentes: ${inv.agentes.length} · hooks do Claude: ${inv.hooks ? "sim" : "não"}`);
  }
  L.push("", `## Ainda não auditadas pelo Garimbot: ${r.nao_auditadas.length} de ${r.diretas} dependência(s) direta(s)`, "", "Para conferir uma: `node garimbot/scripts/garimbot.mjs analisar npm:<nome>@<versão>`.", "");
  for (const x of r.nao_auditadas.slice(0, 60)) L.push("- " + x);
  if (!completo) L.push("", "> A verificação de falhas não terminou: trate o resultado como incompleto.");
  return L.join("\n") + "\n";
}
