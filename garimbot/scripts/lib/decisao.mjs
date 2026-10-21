// Veredito final e nota (seções 3.3 e 5.4). Segurança é eliminatória:
// APROVADO só com o script limpo (nenhum bloqueio, todas as verificações
// concluídas) E os dois revisores independentes aprovando, no MESMO commit,
// sem nenhuma dúvida, E o comitê sem veto (o comitê só pode vetar, nunca
// aprovar o que os revisores reprovaram). Qualquer outra coisa = REPROVADO.
// Nunca completar a lista com reprovados.

// valida a resposta de um revisor (texto da IA vira dado conferido)
export function lerRevisao(r, nome, commit) {
  const erro = (m) => ({ valido: false, motivo: m });
  if (!r || typeof r !== "object") return erro("revisão ausente");
  if (r.repositorio !== nome) return erro("revisão de outro repositório");
  if (r.commit !== commit) return erro("revisão de outro commit");
  if (!["APROVADO", "REPROVADO"].includes(r.veredito)) return erro("veredito inválido");
  const lista = (v) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 300)).filter((x) => x.trim()) : []);
  return {
    valido: true,
    veredito: r.veredito,
    motivos: lista(r.motivos),
    duvidas: lista(r.duvidas),
    injecao: r.tentativa_de_injecao === true || r.tentativa_de_injecao === "true",
  };
}

// valida a resposta do comitê: { repositorio, commit, veto: true|false, motivos: [] }
export function lerComite(c, nome, commit) {
  if (!c || typeof c !== "object") return { valido: false, motivo: "comitê ausente" };
  if (c.repositorio !== nome || c.commit !== commit) return { valido: false, motivo: "comitê de outro repositório ou commit" };
  if (c.veto !== true && c.veto !== false) return { valido: false, motivo: "resposta do comitê inválida" };
  const motivos = Array.isArray(c.motivos) ? c.motivos.map((x) => String(x).slice(0, 300)).filter((x) => x.trim()) : [];
  return { valido: true, veto: c.veto, motivos };
}

export function veredito(resultado, revisoes = [], { revisores = 2, comite = null, exigeComite = true } = {}) {
  const motivos = [];
  if (resultado.incompletas?.length)
    motivos.push("verificação não concluída: " + resultado.incompletas.join(", "));
  for (const a of resultado.achados ?? [])
    if (a.nivel === "bloqueio") motivos.push(`${a.regra} em ${a.arquivo || "repositório"}: ${a.detalhe}`);
  const lidas = revisoes.map((r) => lerRevisao(r, resultado.nome, resultado.commit));
  if (lidas.length < revisores) motivos.push(`faltam revisões (${lidas.length} de ${revisores})`);
  lidas.forEach((l, i) => {
    const quem = `revisor ${String.fromCharCode(65 + i)}`;
    if (!l.valido) motivos.push(`${quem}: ${l.motivo}`);
    else {
      if (l.veredito !== "APROVADO") motivos.push(`${quem} reprovou: ${l.motivos.join("; ") || "sem motivo"}`);
      if (l.duvidas.length) motivos.push(`${quem} ficou com dúvida: ${l.duvidas.join("; ")}`);
      if (l.injecao) motivos.push(`${quem} viu tentativa de dar ordens à IA`);
    }
  });
  // o comitê só entra depois dos dois revisores aprovarem; só pode vetar
  let lidoComite = null;
  if (exigeComite && !motivos.length) {
    lidoComite = lerComite(comite, resultado.nome, resultado.commit);
    if (!lidoComite.valido) motivos.push("comitê: " + lidoComite.motivo);
    else if (lidoComite.veto) motivos.push("comitê vetou: " + (lidoComite.motivos.join("; ") || "sem motivo"));
  }
  return {
    nome: resultado.nome,
    commit: resultado.commit,
    resultado: motivos.length ? "REPROVADO" : "APROVADO",
    motivos: motivos.slice(0, 30),
    revisoes: lidas,
    comite: lidoComite,
  };
}

// ---------- nota (só para os aprovados) ----------
const plain = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
const AGENTES = /\b(mcp|model context protocol|claude|agent|agents|agente|skill|skills|subagent|prompt|llm|ai assistant|copilot)\b/;
export function nota(c, { projetos = {}, criterios = {}, agora = Date.now(), aprendizado = {} } = {}) {
  const pesos = { qualidade: 40, afinidade: 30, agentes: 15, potencial: 15, ...(criterios.pesos ?? {}) };
  const texto = plain([c.nome, c.descricao, ...(c.topicos ?? []), c.linguagem].join(" "));
  // qualidade e reputação (0–1)
  const estrelas = Math.min(1, Math.log10((c.estrelas ?? 0) + 1) / 4.5);
  const forks = Math.min(1, Math.log10((c.forks ?? 0) + 1) / 3.5);
  const diasPush = (agora - Date.parse(c.ultimo_push ?? 0)) / 864e5;
  const atividade = diasPush < 30 ? 1 : diasPush < 90 ? 0.8 : diasPush < 180 ? 0.6 : 0.3;
  const scorecard = c.scorecard != null ? c.scorecard / 10 : 0.5;
  const qualidade = 0.35 * estrelas + 0.15 * forks + 0.3 * atividade + 0.2 * scorecard;
  // afinidade com os projetos e a stack
  const alvos = [];
  let acertos = 0;
  for (const p of projetos.projetos ?? []) {
    const hits = (p.palavras ?? []).filter((w) => texto.includes(plain(w))).length;
    if (hits) alvos.push({ projeto: p.nome, acertos: hits });
    acertos = Math.max(acertos, hits);
  }
  const stack = (projetos.stack ?? []).filter((w) => texto.includes(plain(w))).length;
  const afinidade = Math.min(1, acertos / 2 + stack / 4);
  const agentes = AGENTES.test(texto) ? 1 : 0;
  // potencial geral: muito usado e crescendo
  const idadeAnos = Math.max(0.25, (agora - Date.parse(c.criado ?? 0)) / (365 * 864e5));
  const ritmo = Math.min(1, Math.log10((c.estrelas ?? 0) / idadeAnos + 1) / 3.5);
  const potencial = 0.6 * ritmo + 0.4 * estrelas;
  const bonus = Math.max(-5, Math.min(5, aprendizado[c.tema] ?? 0)); // fase 3: aprendizado (nunca mexe na segurança)
  const total = Math.round(
    Math.max(0, Math.min(100, qualidade * pesos.qualidade + afinidade * pesos.afinidade + agentes * pesos.agentes + potencial * pesos.potencial + bonus)),
  );
  // notas separadas (seção 8.14): 0–100 cada, só para mostrar; a final continua a de cima
  const licencaNota = !c.licenca ? 0 : (criterios.licencas_atencao ?? []).includes(c.licenca) ? 50 : 100;
  const separadas = {
    seguranca: 100, // só aprovados recebem nota: passaram em tudo, sem nenhum achado
    qualidade: Math.round((0.6 * atividade + 0.4 * scorecard) * 100),
    manutencao: Math.round(atividade * 100),
    licenca: licencaNota,
    popularidade: Math.round(Math.min(1, 0.7 * estrelas + 0.3 * forks) * 100),
  };
  return {
    total,
    separadas,
    partes: {
      qualidade: Math.round(qualidade * pesos.qualidade),
      afinidade: Math.round(afinidade * pesos.afinidade),
      agentes: Math.round(agentes * pesos.agentes),
      potencial: Math.round(potencial * pesos.potencial),
    },
    projetos: alvos.sort((a, b) => b.acertos - a.acertos).map((a) => a.projeto),
    oportunidade_nova: afinidade < 0.25 && total >= 45,
  };
}
// até `max` aprovados, do maior para o menor; nunca completa com reprovados
export function ranking(aprovados, opcoes = {}, max = 20) {
  return aprovados
    .map((c) => ({ ...c, nota: nota(c, opcoes) }))
    .sort((a, b) => b.nota.total - a.nota.total)
    .slice(0, max)
    .map((c, i) => ({ ...c, posicao: i + 1 }));
}
