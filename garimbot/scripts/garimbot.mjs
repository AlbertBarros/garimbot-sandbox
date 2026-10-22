#!/usr/bin/env node
// Garimbot · o robozinho garimpeiro da Agência Systein (setor Comando & Controle).
// Uso (PowerShell, na pasta da agência):
//   node garimbot/scripts/garimbot.mjs temas
//   node garimbot/scripts/garimbot.mjs buscar video           (ou --termos "a, b")
//   node garimbot/scripts/garimbot.mjs auditar <execucao>
//   node garimbot/scripts/garimbot.mjs analisar https://github.com/dono/repo
//   node garimbot/scripts/garimbot.mjs revisao <execucao> <dono/repo> <A|B|comite> <arquivo.json>
//   node garimbot/scripts/garimbot.mjs fechar <execucao>
//   node garimbot/scripts/garimbot.mjs clonar <dono/repo> --commit <sha>
//   node garimbot/scripts/garimbot.mjs usar <dono/repo> --commit <sha> --projeto <pasta>
//   node garimbot/scripts/garimbot.mjs guard                  (o Garimbot Guard está ligado?)
//   node garimbot/scripts/garimbot.mjs analisar npm:pacote@1.2.3   (ou pypi:pacote==1.2.3)
//   node garimbot/scripts/garimbot.mjs alertas [--abrir]      (checagem diária, só script)
//   node garimbot/scripts/garimbot.mjs reauditar | semanal | pendentes | agendar
//   node garimbot/scripts/garimbot.mjs emergencia <item> [--motivo "..."]
//   node garimbot/scripts/garimbot.mjs buscar <tema> --fonte npm      (pacotes npm do tema)
//   node garimbot/scripts/garimbot.mjs melhorias | ignorar <item> | projeto <pasta> | resumo [--avisar] | teste <item>
//   node garimbot/scripts/garimbot.mjs buscar <tema> --tipo mcp --licenca comercial --recente --linguagem typescript
//   node garimbot/scripts/garimbot.mjs kit [id] | taxa | ataque | servidor | fila | transformar <repo> --como skill | auditar-pasta <pasta>
// A busca e a auditoria rodam no sandbox (GitHub Actions, sem segredos); as
// revisões são de dois subagentes garimbot-auditor (só leitura) e o comitê
// (garimbot-conselheiro) só pode vetar. Aprovado vai para .garimbot/aprovados.json.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { configs, pastas, AGENCIA, lerJson, gravarJson, memoria, registrar, idExecucao, nomeRepo, pastaDoRepo, RELATORIOS } from "./lib/base.mjs";
import { buscar, buscarNpm, completarDonos, prefiltrar, dadosDoRepo, aplicarFiltros } from "./lib/busca.mjs";
import { auditar, salvarPacote } from "./lib/auditoria.mjs";
import { veredito, ranking } from "./lib/decisao.mjs";
import { relatorioMd, relatorioHtml } from "./lib/relatorio.mjs";
import { clonarQuarentena, prepararUso } from "./lib/quarentena.mjs";
import { gravarAprovado, removerAprovado, conferirGuard, urlGit } from "./lib/guard.mjs";
import { ehPacote, lerSpec, dadosDoPacote, prefiltroPacote } from "./lib/pacotes.mjs";
import { alertas, planoEmergencia } from "./lib/vigia.mjs";
import { tarefas, desligar } from "./lib/agenda.mjs";
import { agentesPara, melhoriasPorAgente, melhoriasMd, aprender, aprendizado } from "./lib/melhorias.mjs";
import { auditarProjeto, projetoMd } from "./lib/projeto.mjs";
import { resumoSemanal, resumoMd, avisar } from "./lib/avisos.mjs";
import { montarKit, kitMd, guardarKit } from "./lib/kits.mjs";
import { promptIntegracao } from "./lib/relatorio.mjs";
import { parecido, POPULARES_NPM, POPULARES_PY } from "./lib/ferramentas.mjs";

// repositório "dono/repo" ou pacote "npm:x@versão" / "pypi:x==versão"
export const nomeItem = (v) => (ehPacote(v) ? String(v).trim() : nomeRepo(v));
// item do .garimbot/aprovados.json no formato do Guard
const itemGuard = (r) =>
  r.candidato?.tipo === "npm" || r.candidato?.tipo === "pypi"
    ? { tipo: r.candidato.tipo, nome: r.candidato.pacote, versao: r.candidato.versao }
    : { tipo: "git", nome: urlGit(r.nome), versao: r.commit };

const args = process.argv.slice(2);
const opc = (nome) => {
  const i = args.indexOf("--" + nome);
  return i >= 0 ? args[i + 1] : undefined;
};
const sai = (msg, codigo = 1) => {
  console.error(msg);
  process.exit(codigo);
};

export async function execucao(id, cfg) {
  if (!/^[\w-]{6,80}$/.test(String(id ?? ""))) throw new Error("Execução inválida.");
  return path.join(pastas().execucoes, id);
}

export async function cmdBuscar({ tema, termos, cfg, fetcher, fonte = "github", filtros = {}, token = process.env.GARIMBOT_GITHUB_TOKEN || process.env.GITHUB_TOKEN }) {
  const t = (cfg.temas.temas ?? []).find((x) => x.id === tema);
  const base = termos?.length ? termos : t?.termos;
  if (!base?.length) throw new Error(`Tema desconhecido: ${tema}. Rode "temas" para ver a lista.`);
  // filtros por tipo e linguagem só valem para o GitHub (o npm já é "biblioteca")
  const lista = fonte === "npm" ? base : aplicarFiltros(base, filtros);
  if (fonte === "npm") return cmdBuscarNpm({ tema, t, lista, cfg, fetcher });
  if (fonte !== "github") throw new Error("Fonte desconhecida: " + fonte + " (use github ou npm).");
  const id = idExecucao(tema || "busca");
  const dir = await execucao(id, cfg);
  const brutos = await buscar({ termos: lista, limite: cfg.limites.candidatos_busca ?? 100, token, fetcher });
  await completarDonos(brutos, { token, fetcher, max: 60 });
  const { aprovados, descartados } = prefiltrar(brutos, { ...cfg.criterios.prefiltro, so_comercial: filtros.licenca === "comercial", recente_meses: filtros.recente ? 3 : undefined });
  // ordem para auditar: os mais promissores primeiro (estrelas e atividade)
  aprovados.sort((a, b) => b.estrelas - a.estrelas);
  await gravarJson(path.join(dir, "candidatos.json"), {
    id, tema: tema ?? null, titulo: t?.nome ?? lista.join(", "), regra: t?.regra ?? null,
    termos: lista, data: new Date().toISOString(), modo: cfg.limites.modo,
    total: brutos.length, aprovados, descartados,
  });
  return { id, dir, total: brutos.length, aprovados: aprovados.length, descartados: descartados.length };
}

// pacotes npm de um tema: registro → dados de cada versão → pré-filtro de pacote
async function cmdBuscarNpm({ tema, t, lista, cfg, fetcher }) {
  const id = idExecucao((tema || "busca") + "-npm");
  const dir = await execucao(id, cfg);
  const achados = await buscarNpm({ termos: lista, limite: cfg.limites.candidatos_busca_pacotes ?? 30, fetcher });
  const imitacao = (n) => parecido(n, POPULARES_NPM);
  const aprovados = [], descartados = [];
  for (const a of achados) {
    const d = await dadosDoPacote({ tipo: "npm", pacote: a.pacote, versao: a.versao }, { fetcher }).catch(() => null);
    if (!d) {
      descartados.push({ nome: `npm:${a.pacote}@${a.versao}`, motivo: "não consegui ler o registro" });
      continue;
    }
    d.topicos = a.topicos;
    d.estrelas = a.downloads; // downloads da semana ocupam o lugar das estrelas na nota
    const motivo = prefiltroPacote(d, { versao_min_dias: cfg.criterios.prefiltro?.versao_min_dias ?? 7, imitacao });
    if (motivo) descartados.push({ nome: d.nome, motivo });
    else aprovados.push(d);
  }
  aprovados.sort((a, b) => (b.estrelas ?? 0) - (a.estrelas ?? 0));
  await gravarJson(path.join(dir, "candidatos.json"), {
    id, tema: tema ?? null, titulo: (t?.nome ?? lista.join(", ")) + " (pacotes npm)", regra: t?.regra ?? null, fonte: "npm",
    termos: lista, data: new Date().toISOString(), modo: cfg.limites.modo, total: achados.length, aprovados, descartados,
  });
  return { id, dir, fonte: "npm", total: achados.length, aprovados: aprovados.length, descartados: descartados.length };
}

export async function cmdAuditar({ id, cfg, fetcher, extras, origens = {} }) {
  const dir = await execucao(id, cfg);
  const cand = await lerJson(path.join(dir, "candidatos.json"));
  const modo = cfg.limites.modo ?? "economico";
  const max = cfg.limites.auditar_por_execucao?.[modo] ?? 25;
  const hist = await lerJson(memoria("historico"), { repositorios: {} });
  const resultados = [];
  const inicio = Date.now();
  const tetoMs = (cfg.limites.teto_execucao_minutos ?? 60) * 60e3;
  const naoAuditados = [];
  for (const c of cand.aprovados.slice(0, max)) {
    // teto de tempo: o que sobrar fica para a próxima (não é reprovado nem aprovado)
    if (Date.now() - inicio > tetoMs) {
      naoAuditados.push(c.nome);
      continue;
    }
    const { resultado, pacote } = await auditar(c, { trabalho: dir, criterios: cfg.criterios, extras, fetcher, origem: origens[c.nome] });
    resultados.push({ ...resultado, candidato: c, cache: hist.repositorios?.[c.nome]?.commit === resultado.commit ? hist.repositorios[c.nome].resultado : null });
    if (pacote && resultado.script === "PARA_REVISAO") await salvarPacote(path.join(dir, "revisao"), pacote);
    await registrar({ acao: "auditoria-script", execucao: id, nome: c.nome, commit: resultado.commit, script: resultado.script, bloqueios: resultado.bloqueios, incompletas: resultado.incompletas });
  }
  const minutos = Math.round((Date.now() - inicio) / 6e3) / 10;
  await gravarJson(path.join(dir, "resultados.json"), { id, resultados, minutos, nao_auditados: naoAuditados });
  return {
    minutos,
    nao_auditados: naoAuditados.length,
    auditados: resultados.length,
    para_revisao: resultados.filter((r) => r.script === "PARA_REVISAO").map((r) => r.nome),
    reprovados_no_script: resultados.filter((r) => r.script === "REPROVADO").length,
  };
}

// análise de um repositório só (URL): mesma auditoria completa
export async function cmdAnalisar({ url, cfg, fetcher, extras, origem, token = process.env.GARIMBOT_GITHUB_TOKEN || process.env.GITHUB_TOKEN }) {
  if (ehPacote(url)) return cmdAnalisarPacote({ spec: url, cfg, fetcher, extras });
  const nome = nomeRepo(url);
  // o porteiro não pula o pré-filtro: só não descarta, mostra o motivo como achado para os revisores
  const dados = origem ? null : await dadosDoRepo(nome, { token, fetcher });
  const id = idExecucao("analise-" + nome.replace("/", "-"));
  const dir = await execucao(id, cfg);
  await gravarJson(path.join(dir, "candidatos.json"), {
    id, tema: null, titulo: "Análise de " + nome, termos: [], data: new Date().toISOString(), modo: cfg.limites.modo,
    total: 1, aprovados: [dados ?? { nome, url: `https://github.com/${nome}`, licenca: null, estrelas: null, descricao: "" }],
    descartados: dados ? prefiltrar([dados], cfg.criterios.prefiltro).descartados : [],
  });
  return { id, ...(await cmdAuditar({ id, cfg, fetcher, extras, origens: { [nome]: origem } })) };
}

// porteiro de pacote npm/PyPI: mesma auditoria, baixando do registro oficial
export async function cmdAnalisarPacote({ spec, cfg, fetcher, extras }) {
  const d = await dadosDoPacote(lerSpec(spec), { fetcher });
  const id = idExecucao("pacote-" + d.nome);
  const dir = await execucao(id, cfg);
  const imitacao = (n) => parecido(n, d.tipo === "npm" ? POPULARES_NPM : POPULARES_PY);
  const motivo = prefiltroPacote(d, { versao_min_dias: cfg.criterios.prefiltro?.versao_min_dias ?? 7, imitacao });
  await gravarJson(path.join(dir, "candidatos.json"), {
    id, tema: null, titulo: "Análise de " + d.nome, termos: [], data: new Date().toISOString(), modo: cfg.limites.modo,
    total: 1, aprovados: [d], descartados: motivo ? [{ nome: d.nome, motivo }] : [],
  });
  return { id, ...(await cmdAuditar({ id, cfg, fetcher, extras })) };
}

// guarda a resposta de um revisor (A ou B) ou do comitê depois de conferir o formato
export async function cmdRevisao({ id, nome, quem, conteudo, cfg }) {
  if (!["A", "B", "comite"].includes(quem)) throw new Error("Revisor A, B ou comite.");
  const dir = await execucao(id, cfg);
  const json = typeof conteudo === "string" ? JSON.parse(/\{[\s\S]*\}/.exec(conteudo)?.[0] ?? "null") : conteudo;
  if (!json || json.repositorio !== nomeItem(nome)) throw new Error("A revisão não é deste repositório.");
  await gravarJson(path.join(dir, "revisoes", `${pastaDoRepo(nome)}.${quem}.json`), json);
  return true;
}

export async function cmdFechar({ id, cfg, agora = new Date() }) {
  const dir = await execucao(id, cfg);
  const cand = await lerJson(path.join(dir, "candidatos.json"));
  const { resultados, minutos = null, nao_auditados = [] } = await lerJson(path.join(dir, "resultados.json"));
  const hist = await lerJson(memoria("historico"), { repositorios: {} });
  const bloq = await lerJson(memoria("bloqueados"), { repositorios: {} });
  const q = pastas();
  const guard = await conferirGuard(AGENCIA);
  const aprovados = [],
    reprovados = [];
  let revisoes = 0;
  for (const r of resultados) {
    const revs = [];
    for (const q of ["A", "B"]) {
      const rv = await lerJson(path.join(dir, "revisoes", `${pastaDoRepo(r.nome)}.${q}.json`), null);
      if (rv) {
        revs.push(rv);
        revisoes++;
      }
    }
    const comite = await lerJson(path.join(dir, "revisoes", `${pastaDoRepo(r.nome)}.comite.json`), null);
    const v = veredito(r, revs, {
      revisores: cfg.criterios.seguranca?.revisores ?? 2,
      comite,
      exigeComite: cfg.criterios.seguranca?.comite !== false,
    });
    // análise de link: o que o pré-filtro descartaria também reprova (sem licença, abandonado…)
    const pre = (cand.descartados ?? []).find((d) => d.nome === r.nome);
    if (pre) {
      v.motivos.unshift("pré-filtro: " + pre.motivo);
      v.resultado = "REPROVADO";
    }
    hist.repositorios[r.nome] = { commit: r.commit, resultado: v.resultado, data: agora.toISOString(), execucao: id };
    if (v.resultado === "APROVADO") {
      delete bloq.repositorios[r.nome];
      // só o que passou no script, nos 2 revisores e no comitê entra na lista do Guard
      await gravarAprovado(q.aprovados, itemGuard(r), agora);
      aprovados.push({
        ...r.candidato, tema: cand.tema, commit: r.commit, ferramentas: r.ferramentas,
        agentes: agentesPara(r.candidato, cfg.agentes),
        licencaAtencao: r.licenca?.atencao,
        avisos: cand.regra === "whatsapp" && !/cloud api|business api|meta/i.test(`${r.candidato.nome} ${r.candidato.descricao}`)
          ? ["WhatsApp não oficial: viola os termos do WhatsApp e pode banir o número. Use um número secundário para testar."]
          : [],
      });
    } else {
      await removerAprovado(q.aprovados, itemGuard(r));
      bloq.repositorios[r.nome] = { commit: r.commit, motivos: v.motivos.slice(0, 5), data: agora.toISOString() };
      reprovados.push({ nome: r.nome, commit: r.commit, motivos: v.motivos });
    }
    await registrar({ acao: "veredito", execucao: id, nome: r.nome, commit: r.commit, resultado: v.resultado, motivos: v.motivos.slice(0, 5) }, agora);
  }
  await rm(path.join(dir, "repos"), { recursive: true, force: true }); // clones da análise saem da máquina
  await gravarJson(memoria("historico"), hist);
  await gravarJson(memoria("bloqueados"), bloq);
  // aprendizado (só a nota, até ±5 por tema; nunca a segurança)
  const lista = ranking(aprovados, { projetos: cfg.projetos, criterios: cfg.criterios, aprendizado: await aprendizado() }, cfg.criterios.entrega_maxima ?? 20);
  for (const a of lista)
    Object.assign(hist.repositorios[a.nome], {
      nota: a.nota.total, tema: cand.tema ?? null, tipo: a.tipo ?? "git", url: a.url ?? null,
      descricao: String(a.descricao ?? "").slice(0, 300), topicos: (a.topicos ?? []).slice(0, 20), linguagem: a.linguagem ?? null, licenca: a.licenca ?? null,
    });
  await gravarJson(memoria("historico"), hist);
  const exec = {
    id, titulo: cand.titulo, data: agora.toISOString(), modo: cand.modo,
    candidatos: cand.total, auditados: resultados.length, descartados: cand.descartados,
    aprovados: lista, reprovados, revisoes,
    avisos: [
      ...(guard.aviso ? [guard.aviso] : []),
      ...(cand.regra === "whatsapp"
        ? ["WhatsApp: a opção oficial é a WhatsApp Business Cloud API (Meta, direto ou parceiros). As não oficiais violam os termos e podem banir o número; risco de banimento é aviso, não reprovação."]
        : []),
    ],
  };
  const uso = await lerJson(memoria("uso"), { execucoes: [] });
  // modo econômico: avisa quando esta execução passou muito da média das anteriores
  const anteriores = uso.execucoes.filter((e) => e.minutos != null).slice(-10);
  const media = anteriores.length >= 3 ? anteriores.reduce((s, e) => s + e.minutos, 0) / anteriores.length : null;
  const fator = cfg.limites.alerta_acima_da_media ?? 2;
  if (media && minutos != null && minutos > media * fator)
    exec.avisos.push(`Esta execução levou ${minutos} min, mais de ${fator}× a média (${Math.round(media * 10) / 10} min). Confira os temas ou use o modo econômico.`);
  if (nao_auditados.length) exec.avisos.push(`${nao_auditados.length} candidato(s) ficaram para a próxima por causa do teto de tempo (${cfg.limites.teto_execucao_minutos ?? 60} min): nem aprovados nem reprovados.`);
  uso.execucoes.push({ id, data: agora.toISOString(), candidatos: cand.total, auditados: resultados.length, revisoes, aprovados: lista.length, minutos });
  uso.execucoes = uso.execucoes.slice(-200);
  await gravarJson(memoria("uso"), uso);
  const ag = await lerJson(memoria("agendada"), null);
  if (ag?.execucoes?.includes(id)) {
    ag.fechadas = [...new Set([...(ag.fechadas ?? []), id])];
    await gravarJson(memoria("agendada"), ag);
  }
  const nomeArq = agora.toISOString().slice(0, 10) + "-" + (cand.tema ?? "analise");
  await mkdir(RELATORIOS, { recursive: true });
  await writeFile(path.join(RELATORIOS, nomeArq + ".md"), relatorioMd(exec));
  await writeFile(path.join(dir, "relatorio.html"), relatorioHtml(exec));
  return { relatorio: path.join(RELATORIOS, nomeArq + ".md"), html: path.join(dir, "relatorio.html"), aprovados: lista.length, reprovados: reprovados.length, guard: guard.aviso ?? "ligado" };
}

// ---------- fase 2: vigia, reauditoria, execução agendada ----------
export async function cmdAlertas({ fetcher, agora } = {}) {
  return alertas({ aprovadosArq: pastas().aprovados, fetcher, agora });
}

// repositórios que mudaram desde a auditoria: auditoria nova do commit atual (só script; a dupla checagem vem depois)
export async function cmdReauditar({ cfg, fetcher, agora = new Date(), origens = {} }) {
  const al = await lerJson(memoria("alertas"), { alertas: [] });
  const hist = await lerJson(memoria("historico"), { repositorios: {} });
  const nomes = [...new Set(al.alertas.filter((a) => a.nivel === "reauditar" && a.tipo === "git").map((a) => a.item))];
  if (!nomes.length) return { id: null, auditados: 0, para_revisao: [] };
  const id = idExecucao("reauditoria", agora);
  const dir = await execucao(id, cfg);
  await gravarJson(path.join(dir, "candidatos.json"), {
    id, tema: "reauditoria", titulo: "Reauditoria da watchlist", termos: [], data: agora.toISOString(), modo: cfg.limites.modo,
    total: nomes.length, descartados: [],
    aprovados: nomes.map((nome) => ({ nome, url: `https://github.com/${nome}`, licenca: hist.repositorios?.[nome]?.licenca ?? null, descricao: "", reauditoria: true })),
  });
  return { id, ...(await cmdAuditar({ id, cfg, fetcher, origens })) };
}

// execução agendada (só scripts): alertas, reauditoria e os temas da semana, dentro dos tetos
export async function cmdSemanal({ cfg, fetcher, agora = new Date() }) {
  const uso = await lerJson(memoria("uso"), { execucoes: [] });
  const mes = agora.toISOString().slice(0, 7);
  const noMes = uso.execucoes.filter((e) => String(e.data).startsWith(mes)).length;
  const teto = cfg.limites.teto_mes_execucoes ?? 8;
  const al = await cmdAlertas({ fetcher, agora });
  if (noMes >= teto) {
    await registrar({ acao: "semanal-pulada", motivo: "teto do mês", noMes, teto }, agora);
    return { pulou: true, motivo: `teto de ${teto} execuções no mês atingido (${noMes}); só os alertas rodaram`, alertas: al.alertas.length, emergencias: al.emergencias };
  }
  const ids = [];
  const re = await cmdReauditar({ cfg, fetcher, agora });
  if (re.id) ids.push(re.id);
  // pedidos de auditoria que você fez pela extensão do navegador
  for (const f of await cmdFila({ cfg, fetcher, max: Math.max(0, Math.min(5, teto - noMes - ids.length)) })) if (f.id) ids.push(f.id);
  const temas = cfg.agendamento.temas?.length ? cfg.agendamento.temas : ["seguranca", "video", "apis", "whatsapp", "redes-sociais"];
  for (const tema of temas.slice(0, Math.max(0, teto - noMes - ids.length))) {
    try {
      const b = await cmdBuscar({ tema, cfg, fetcher });
      await cmdAuditar({ id: b.id, cfg, fetcher });
      ids.push(b.id);
    } catch (e) {
      await registrar({ acao: "semanal-tema-falhou", tema, erro: String(e.message).slice(0, 200) }, agora);
    }
  }
  await gravarJson(memoria("agendada"), { data: agora.toISOString(), execucoes: ids, fechadas: [] });
  await registrar({ acao: "semanal", execucoes: ids }, agora);
  return { execucoes: ids, alertas: al.alertas.length, emergencias: al.emergencias };
}

// o que a execução agendada deixou para a dupla checagem
export async function cmdPendentes({ cfg }) {
  const ag = await lerJson(memoria("agendada"), { execucoes: [], fechadas: [] });
  const out = [];
  for (const id of ag.execucoes.filter((x) => !(ag.fechadas ?? []).includes(x))) {
    const dir = await execucao(id, cfg);
    const pac = (await readdir(path.join(dir, "revisao")).catch(() => [])).map((f) => path.join(dir, "revisao", f));
    out.push({ execucao: id, pacotes: pac });
  }
  return out;
}

// plano de emergência a pedido do dono: tira da lista do Guard e escreve o passo a passo (nada é apagado)
export async function cmdEmergencia({ item, motivo = "pedido do dono", agora = new Date() }) {
  const nome = nomeItem(item);
  const q = pastas();
  if (ehPacote(nome)) {
    const s = lerSpec(nome);
    await removerAprovado(q.aprovados, { tipo: s.tipo, nome: s.pacote, versao: s.versao });
  } else await removerAprovado(q.aprovados, { tipo: "git", nome: urlGit(nome) });
  const tipo = ehPacote(nome) ? lerSpec(nome).tipo : "git";
  return planoEmergencia({ item: nome, tipo, motivo, nivel: "emergencia" }, { agora });
}

// ---------- fase 3 ----------
// o dono não quis um aprovado: a nota do tema cai 1 (até -5); a segurança não muda
export async function cmdIgnorar({ item }) {
  const nome = nomeItem(item);
  const h = (await lerJson(memoria("historico"), { repositorios: {} })).repositorios?.[nome];
  return { tema: h?.tema ?? null, nota_do_tema: await aprender(h?.tema, -1, { item: nome, acao: "ignorar" }) };
}
export async function cmdMelhorias({ cfg, agora = new Date(), nomes = {} }) {
  const porAgente = melhoriasPorAgente(await lerJson(memoria("historico"), { repositorios: {} }), cfg.agentes);
  await gravarJson(memoria("agentes"), { data: agora.toISOString(), porAgente });
  const arq = path.join(RELATORIOS, "melhorias-agentes.md");
  await mkdir(RELATORIOS, { recursive: true });
  await writeFile(arq, melhoriasMd(porAgente, nomes, agora));
  return { arquivo: arq, agentes: Object.keys(porAgente).length };
}
export async function cmdProjeto({ pasta, fetcher, agora = new Date() }) {
  const r = await auditarProjeto(path.resolve(pasta), { aprovadosArq: pastas().aprovados, fetcher });
  const arq = path.join(RELATORIOS, `projeto-${pastaDoRepo(r.nome)}-${agora.toISOString().slice(0, 10)}.md`);
  await mkdir(RELATORIOS, { recursive: true });
  await writeFile(arq, projetoMd(r, agora));
  await registrar({ acao: "auditoria-projeto", projeto: r.nome, falhas: r.falhas.length, nao_auditadas: r.nao_auditadas.length }, agora);
  return { arquivo: arq, falhas: r.falhas.length, nao_auditadas: r.nao_auditadas.length, verificacao: r.verificacao };
}
export async function cmdResumo({ cfg, agora = new Date(), enviar = false, env, fetcher }) {
  const r = await resumoSemanal({ agora, notaDestaque: cfg.limites.nota_notificacao ?? 85 });
  const arq = path.join(RELATORIOS, "semanal", agora.toISOString().slice(0, 10) + ".md");
  await mkdir(path.dirname(arq), { recursive: true });
  await writeFile(arq, resumoMd(r));
  const avisos = enviar ? await avisar(r, { env, fetcher }) : ["sem envio (use --avisar)"];
  await registrar({ acao: "resumo-semanal", aprovados: r.aprovados.length, alertas: r.alertas.length, avisos }, agora);
  return { arquivo: arq, status: r.status, avisos };
}

// ---------- fase 4 (seção 8.14) ----------
export async function cmdKit({ cfg, id, agora = new Date() }) {
  const def = (cfg.kits.kits ?? []).find((k) => k.id === id);
  if (!def) throw new Error("Kit desconhecido. Kits: " + (cfg.kits.kits ?? []).map((k) => k.id).join(", "));
  const k = montarKit(def, await lerJson(memoria("historico"), { repositorios: {} }));
  if (k.completo) await guardarKit(k, agora);
  const arq = path.join(RELATORIOS, `kit-${k.id}.md`);
  await mkdir(RELATORIOS, { recursive: true });
  await writeFile(arq, kitMd(k, promptIntegracao));
  return { arquivo: arq, completo: k.completo, faltam: k.pecas.filter((p) => !p.item).map((p) => p.peca) };
}
// pedidos da extensão do navegador (fila): auditar vira análise; watchlist só registra
export async function cmdFila({ cfg, fetcher, max = 5 }) {
  const fila = await lerJson(memoria("fila"), { pedidos: [] });
  const feitos = [];
  for (const p of fila.pedidos.slice(0, max)) {
    const alvo = p.item.startsWith("github:") ? p.item.slice(7) : p.item;
    try {
      if (p.acao === "auditar") feitos.push({ item: p.item, ...(await cmdAnalisar({ url: alvo, cfg, fetcher })) });
      else {
        const { adicionarWatchlist } = await import("./lib/quarentena.mjs");
        await adicionarWatchlist({ nome: alvo, commit: null, pasta: null, clonadoEm: null, observado: true });
        feitos.push({ item: p.item, watchlist: true });
      }
    } catch (e) {
      feitos.push({ item: p.item, erro: String(e.message).slice(0, 160) });
    }
  }
  fila.pedidos = fila.pedidos.slice(max);
  await gravarJson(memoria("fila"), fila);
  return feitos;
}

async function main() {
  const cfg = await configs();
  const [cmd, a1, a2, a3, a4] = args;
  const q = pastas();
  // o Guard tem que estar ligado em toda execução (só avisa; quem liga é o dono)
  if (!["temas", "guard", "agendar"].includes(cmd)) {
    const g = await conferirGuard(AGENCIA);
    if (!g.instalado) console.error(g.aviso);
  }
  switch (cmd) {
    case "alertas": {
      const r = await cmdAlertas({});
      for (const a of r.alertas) console.log(`[${a.nivel}] ${a.item}: ${a.motivo}${a.plano ? " → plano: " + a.plano : ""}`);
      console.log(`${r.conferidos} item(ns) conferido(s), ${r.alertas.length} alerta(s), ${r.emergencias} emergência(s).`);
      // no PC, emergência abre o plano no Bloco de Notas (execução agendada às 7h)
      if (args.includes("--abrir") && process.platform === "win32")
        for (const a of r.alertas.filter((x) => x.plano)) (await import("node:child_process")).spawn("notepad.exe", [a.plano], { detached: true, stdio: "ignore" }).unref();
      // emergência: avisa por e-mail e no sino do painel (se configurados no .env do PC)
      if (r.emergencias && args.includes("--avisar")) console.log("Avisos: " + (await cmdResumo({ cfg, enviar: true })).avisos.join(" · "));
      if (r.emergencias) process.exitCode = 2;
      return;
    }
    case "reauditar":
      console.log(JSON.stringify(await cmdReauditar({ cfg }), null, 2));
      return;
    case "semanal":
      console.log(JSON.stringify(await cmdSemanal({ cfg }), null, 2));
      return;
    case "ignorar":
      console.log(JSON.stringify(await cmdIgnorar({ item: a1 }), null, 2));
      return;
    case "melhorias":
      console.log(JSON.stringify(await cmdMelhorias({ cfg }), null, 2));
      return;
    case "projeto":
      if (!a1) sai("Informe a pasta do projeto.");
      console.log(JSON.stringify(await cmdProjeto({ pasta: a1 }), null, 2));
      return;
    case "resumo":
      console.log(JSON.stringify(await cmdResumo({ cfg, enviar: args.includes("--avisar") }), null, 2));
      return;
    case "mcp-teste": {
      // SÓ NO SANDBOX (executa o servidor): node garimbot.mjs mcp-teste -- <comando> [args]
      if (!process.env.GITHUB_ACTIONS && !args.includes("--sei-que-executa")) sai("O teste do MCP executa o servidor: rode só no sandbox do GitHub (garimbot-teste.yml).");
      const i = args.indexOf("--");
      const [c, ...resto] = args.slice(i + 1);
      const { listarFerramentas, analisarFerramentas } = await import("./lib/mcp.mjs");
      console.log(JSON.stringify(analisarFerramentas(await listarFerramentas(c, resto)), null, 2));
      return;
    }
    case "kit": {
      if (!a1) {
        for (const k of cfg.kits.kits ?? []) console.log(`${k.id.padEnd(22)} ${k.nome}`);
        return;
      }
      console.log(JSON.stringify(await cmdKit({ cfg, id: a1 }), null, 2));
      return;
    }
    case "taxa": {
      const { taxaDeAcerto } = await import("./lib/taxa.mjs");
      const t = await taxaDeAcerto();
      console.log(`Ameaças detectadas: ${t.detectadas} de ${t.maliciosos} · alarmes falsos: ${t.alarmes_falsos} de ${t.confiaveis}`);
      if (t.perdidas.length) console.log("Não detectadas: " + t.perdidas.join(", "));
      if (t.falsos.length) console.log("Alarmes falsos: " + t.falsos.map((f) => `${f.nome} (${f.regras.join(", ")})`).join("; "));
      if (t.perdidas.length) process.exitCode = 1;
      return;
    }
    case "ataque": {
      const { conferirAgentes, ataqueMd } = await import("./lib/ataque.mjs");
      const lista = await conferirAgentes(AGENCIA);
      const arq = path.join(RELATORIOS, "ataque-agentes.md");
      await mkdir(RELATORIOS, { recursive: true });
      await writeFile(arq, ataqueMd(lista));
      console.log(`Relatório: ${arq} · ${lista.filter((a) => a.faltam.length).length} de ${lista.length} agente(s) com defesa faltando.`);
      return;
    }
    case "servidor": {
      const { criarServidor, PORTA } = await import("./lib/servidor.mjs");
      criarServidor().listen(PORTA, "127.0.0.1", () => console.log(`Garimbot para a extensão do navegador: http://127.0.0.1:${PORTA} (só neste computador). Ctrl+C para parar.`));
      return;
    }
    case "fila":
      console.log(JSON.stringify(await cmdFila({ cfg }), null, 2));
      return;
    case "transformar": {
      const { transformar } = await import("./lib/transformar.mjs");
      console.log(JSON.stringify(await transformar(nomeItem(a1), opc("como") ?? "skill"), null, 2));
      return;
    }
    case "auditar-pasta": {
      const { auditarPasta } = await import("./lib/transformar.mjs");
      const r = await auditarPasta(path.resolve(a1 ?? "."));
      console.log(JSON.stringify({ ...r, bloqueios: r.bloqueios.map((b) => `${b.regra} em ${b.arquivo}`), revisar: r.revisar.map((b) => `${b.regra} em ${b.arquivo}`) }, null, 2));
      if (r.resultado === "REPROVADO") process.exitCode = 1;
      return;
    }
    case "teste":
      console.log(
        "Teste de funcionamento (pesado, sob demanda): roda só no sandbox do GitHub, numa máquina descartável, nunca no seu PC.\n" +
          "GitHub › garimbot-sandbox › Actions › Garimbot teste de funcionamento › Run workflow › item: " + (a1 ?? "<dono/repo>") + (opc("commit") ? " · commit: " + opc("commit") : ""),
      );
      return;
    case "pendentes":
      console.log(JSON.stringify(await cmdPendentes({ cfg }), null, 2));
      return;
    case "emergencia":
      console.log("Plano de emergência: " + (await cmdEmergencia({ item: a1, motivo: opc("motivo") ?? "pedido do dono" })));
      return;
    case "agendar": {
      const lista = tarefas(cfg.agendamento, AGENCIA);
      console.log("Cole no PowerShell (uma vez) para agendar no Windows:\n");
      for (const t of lista) console.log(t.comando);
      console.log("\nPara desligar depois:\n" + desligar(lista).join("\n"));
      return;
    }
    case "guard": {
      const g = await conferirGuard(AGENCIA);
      console.log(g.instalado ? "Garimbot Guard ligado ✓" : g.aviso);
      if (!g.instalado) process.exitCode = 1;
      return;
    }
    case "temas":
      for (const t of cfg.temas.temas) console.log(`${t.id.padEnd(20)} ${t.nome}`);
      return;
    case "buscar": {
      const termos = opc("termos")?.split(",").map((s) => s.trim()).filter(Boolean);
      const filtros = { tipo: opc("tipo"), linguagem: opc("linguagem"), licenca: opc("licenca"), recente: args.includes("--recente") };
      const r = await cmdBuscar({ tema: termos ? null : a1, termos, cfg, fonte: opc("fonte") ?? "github", filtros });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case "auditar":
      console.log(JSON.stringify(await cmdAuditar({ id: a1, cfg }), null, 2));
      return;
    case "analisar":
      console.log(JSON.stringify(await cmdAnalisar({ url: a1, cfg }), null, 2));
      return;
    case "revisao":
      // a resposta vem de um arquivo ou direto em --json '<texto>' (execução agendada)
      await cmdRevisao({ id: a1, nome: a2, quem: a3, conteudo: opc("json") ?? (await readFile(a4, "utf8")), cfg });
      console.log("Revisão guardada.");
      return;
    case "fechar":
      console.log(JSON.stringify(await cmdFechar({ id: a1, cfg }), null, 2));
      return;
    case "clonar": {
      const r = await clonarQuarentena(a1, opc("commit"), { quarentena: q.quarentena });
      await aprender((await lerJson(memoria("historico"), { repositorios: {} })).repositorios?.[nomeRepo(a1)]?.tema, +1, { item: a1, acao: "clonar" });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case "usar": {
      const projeto = opc("projeto");
      if (!projeto) sai("Informe --projeto <pasta do projeto>.");
      const r = await prepararUso(a1, opc("commit"), { quarentena: q.quarentena, projeto: path.resolve(projeto) });
      await aprender((await lerJson(memoria("historico"), { repositorios: {} })).repositorios?.[nomeRepo(a1)]?.tema, +1, { item: a1, acao: "usar" });
      console.log(JSON.stringify(r, null, 2));
      console.log("Branch criado. Próximo passo: o plano de integração (nada foi instalado).");
      return;
    }
    case "pacotes": {
      const dir = await execucao(a1, cfg);
      const lista = await readdir(path.join(dir, "revisao")).catch(() => []);
      for (const f of lista) console.log(path.join(dir, "revisao", f), "→ código em", path.join(dir, "repos", f.replace(/\.json$/, "")));
      return;
    }
    default:
      sai("Comandos: temas | buscar | auditar | analisar | pacotes | revisao | fechar | clonar | usar | guard | alertas | reauditar | semanal | pendentes | emergencia | agendar | ignorar | melhorias | projeto | resumo | teste | kit | taxa | ataque | servidor | fila | transformar | auditar-pasta | mcp-teste");
  }
}
// fileURLToPath: no Windows, o pathname da URL vira "/C:/..." e nunca bateria com o caminho
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase())
  main().catch((e) => sai("Garimbot: " + e.message));
