// Fase 3: melhoria dos agentes e aprendizado. O Garimbot só SUGERE o que cada
// agente ganharia com os aprovados (nada é instalado), e as escolhas do dono
// (clonou, usou, ignorou) mexem só na NOTA de cada tema, até ±5. A segurança
// nunca muda com o aprendizado.
import { lerJson, gravarJson, memoria, registrar } from "./base.mjs";

const plain = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

// agentes que ganham com um item aprovado (pelas palavras de config/agentes.yml)
export function agentesPara(item, mapa = {}) {
  const texto = " " + plain([item.nome, item.descricao, ...(item.topicos ?? []), item.linguagem].join(" ")) + " ";
  return (mapa.agentes ?? [])
    .map((a) => ({ id: a.id, acertos: (a.palavras ?? []).filter((p) => texto.includes(" " + plain(p)) || texto.includes(plain(p) + " ")).length }))
    .filter((a) => a.acertos)
    .sort((a, b) => b.acertos - a.acertos)
    .slice(0, 3)
    .map((a) => a.id);
}

// relatório de melhorias: por agente, os aprovados (do histórico) que servem para ele
export function melhoriasPorAgente(historico, mapa) {
  const porAgente = {};
  for (const [nome, h] of Object.entries(historico.repositorios ?? {})) {
    if (h.resultado !== "APROVADO") continue;
    for (const id of agentesPara({ nome, ...h }, mapa)) (porAgente[id] ??= []).push({ nome, url: h.url, descricao: h.descricao, data: h.data, tipo: h.tipo ?? "git" });
  }
  return porAgente;
}
export function melhoriasMd(porAgente, nomes = {}, agora = new Date()) {
  const L = [`# Garimbot · melhorias para os agentes`, "", `${agora.toISOString().slice(0, 10).split("-").reverse().join("/")} · só sugestões a partir do que já foi APROVADO (script, 2 revisores e comitê). Nada foi instalado.`, ""];
  const ids = Object.keys(porAgente).sort();
  if (!ids.length) L.push("Ainda não há aprovados que sirvam para algum agente.");
  for (const id of ids) {
    L.push(`## ${nomes[id] ? nomes[id] + " · " : ""}${id}`, "");
    for (const i of porAgente[id]) L.push(`- **${i.nome}**${i.descricao ? " — " + String(i.descricao).replace(/\r?\n/g, " ").slice(0, 140) + " _(texto do autor)_" : ""}`);
    L.push("");
  }
  L.push("> Para usar um deles: peça ao Einstein \"clonar\" ou \"usar no projeto\" (sempre no commit auditado) e depois o plano de integração.");
  return L.join("\n") + "\n";
}

// aprendizado: +1 quando o dono clona/usa, -1 quando ignora; sempre entre -5 e +5
export async function aprender(tema, delta, { item, acao, agora = new Date() } = {}) {
  if (!tema) return null;
  const p = await lerJson(memoria("preferencias"), { temas: {} });
  p.temas ??= {};
  p.temas[tema] = Math.max(-5, Math.min(5, (p.temas[tema] ?? 0) + delta));
  if (acao === "ignorar" && item) p.ignorados = [...new Set([...(p.ignorados ?? []), item])].slice(-500);
  await gravarJson(memoria("preferencias"), p);
  await registrar({ acao: "aprendizado", tema, delta, item, motivo: acao }, agora);
  return p.temas[tema];
}
export async function aprendizado() {
  return (await lerJson(memoria("preferencias"), { temas: {} })).temas ?? {};
}
