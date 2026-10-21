// Ligação com o Garimbot Guard (.claude/hooks/garimbot-guard.mjs). O Garimbot
// NÃO tem Guard próprio: só grava em .garimbot/aprovados.json o que passou na
// auditoria, na dupla checagem e no comitê, e confere se o Guard está ligado.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { lerJson, gravarJson, registrar } from "./base.mjs";

const TIPOS = ["npm", "pypi", "git"];
export const urlGit = (nome) => `https://github.com/${nome}`;

export async function lerAprovados(arquivo) {
  const d = await lerJson(arquivo, { itens: [] });
  return { itens: Array.isArray(d.itens) ? d.itens : [] };
}

// um item por nome+tipo: a versão nova (commit auditado) substitui a anterior
export async function gravarAprovado(arquivo, { tipo, nome, versao }, agora = new Date()) {
  if (!TIPOS.includes(tipo)) throw new Error("tipo inválido: " + tipo);
  if (!nome || !versao) throw new Error("nome e versão são obrigatórios");
  const d = await lerAprovados(arquivo);
  const igual = (i) => i.tipo === tipo && String(i.nome).toLowerCase() === String(nome).toLowerCase();
  d.itens = [...d.itens.filter((i) => !igual(i)), { tipo, nome, versao: String(versao), aprovado_em: agora.toISOString().slice(0, 10) }];
  await gravarJson(arquivo, d);
  await registrar({ acao: "aprovados.json", tipo, nome, versao }, agora);
  return d;
}
// reprovado depois (reauditoria, alerta): sai da lista do Guard. Pacote: só a
// versão reprovada; repositório (o Guard não fixa commit): a URL inteira.
export async function removerAprovado(arquivo, { tipo, nome, versao }) {
  const d = await lerAprovados(arquivo);
  const antes = d.itens.length;
  const mesmaVersao = (i) => tipo === "git" || !versao || String(i.versao) === String(versao);
  d.itens = d.itens.filter((i) => !(i.tipo === tipo && String(i.nome).toLowerCase() === String(nome).toLowerCase() && mesmaVersao(i)));
  if (d.itens.length !== antes) {
    await gravarJson(arquivo, d);
    await registrar({ acao: "aprovados.json-removido", tipo, nome });
  }
  return antes - d.itens.length;
}

// o Guard está instalado? (arquivo do hook + PreToolUse do Bash no settings.json)
export async function conferirGuard(agencia) {
  const hook = path.join(agencia, ".claude", "hooks", "garimbot-guard.mjs");
  const problemas = [];
  if (!existsSync(hook)) problemas.push("falta o arquivo .claude/hooks/garimbot-guard.mjs");
  let ligado = false;
  try {
    const s = JSON.parse(await readFile(path.join(agencia, ".claude", "settings.json"), "utf8"));
    ligado = (s.hooks?.PreToolUse ?? []).some(
      (h) => /(^|\|)Bash(\||$)/.test(h.matcher ?? "") && (h.hooks ?? []).some((x) => /garimbot-guard\.mjs/.test([x.command, ...(x.args ?? [])].join(" "))),
    );
  } catch {
    problemas.push("não consegui ler .claude/settings.json");
  }
  if (!ligado) problemas.push("o hook PreToolUse (Bash) do Guard não está no .claude/settings.json");
  if (!existsSync(path.join(agencia, ".garimbot", "aprovados.json"))) problemas.push("falta .garimbot/aprovados.json");
  return {
    instalado: problemas.length === 0,
    problemas,
    aviso: problemas.length ? "⚠ Garimbot Guard não está instalado direito: " + problemas.join("; ") + ". Veja garimbot/docs/CONTINUIDADE.md." : null,
  };
}
