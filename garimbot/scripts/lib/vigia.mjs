// Vigia do Garimbot (fase 2): alerta diário só por script, reauditoria da
// watchlist e plano de emergência. Nada aqui executa código de terceiros,
// apaga arquivos do dono ou revoga credenciais: só avisa, tira da lista do
// Guard o que deixou de ser seguro e escreve o passo a passo.
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rodar, disponivel } from "./ferramentas.mjs";
import { lerJson, gravarJson, memoria, registrar, DATA, pastaDoRepo } from "./base.mjs";
import { lerAprovados, removerAprovado } from "./guard.mjs";
import { dadosDoPacote } from "./pacotes.mjs";
import { kitsSuspensos } from "./kits.mjs";

const repoDaUrl = (url) => /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;

// commit atual do repositório (sem baixar código)
async function headRemoto(url) {
  const r = await rodar("git", ["ls-remote", url, "HEAD"], { timeoutMs: 60e3 });
  return r.codigo === 0 ? r.out.split(/\s/)[0] || null : null;
}

// falhas conhecidas de versões exatas (osv-scanner com SBOM; GARIMBOT_OSV_OFFLINE=1 usa a base baixada)
async function falhasConhecidas(itens, { fetcher = fetch } = {}) {
  if (!itens.length) return { ok: true, achados: [] };
  if (await disponivel("osv-scanner")) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "osv-"));
    try {
      const sbom = path.join(tmp, "aprovados.cdx.json");
      const purl = (i) => (i.tipo === "npm" ? "pkg:npm/" + i.nome.replace("@", "%40") : "pkg:pypi/" + i.nome.toLowerCase()) + "@" + i.versao;
      await writeFile(sbom, JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.4", version: 1, components: itens.map((i) => ({ type: "library", name: i.nome, version: i.versao, purl: purl(i) })) }));
      const offline = process.env.GARIMBOT_OSV_OFFLINE === "1" ? ["--experimental-offline-vulnerabilities", "--experimental-download-offline-databases"] : [];
      const r = await rodar("osv-scanner", ["scan", "--format", "json", ...offline, "--sbom", sbom], { timeoutMs: 10 * 60e3 });
      if (![0, 1, 128].includes(r.codigo)) return { ok: false, erro: "osv-scanner falhou" };
      const d = JSON.parse(r.out || '{"results":[]}');
      const achados = [];
      for (const res of d.results ?? []) for (const pk of res.packages ?? []) for (const v of pk.vulnerabilities ?? []) achados.push({ nome: pk.package?.name, versao: pk.package?.version, id: v.id });
      return { ok: true, achados };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  try {
    const r = await fetcher("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: itens.map((i) => ({ package: { ecosystem: i.tipo === "npm" ? "npm" : "PyPI", name: i.nome }, version: i.versao })) }),
    });
    if (!r.ok) return { ok: false, erro: "API do OSV respondeu " + r.status };
    const d = await r.json();
    return { ok: true, achados: (d.results ?? []).flatMap((res, k) => (res.vulns ?? []).map((v) => ({ nome: itens[k].nome, versao: itens[k].versao, id: v.id }))) };
  } catch (e) {
    return { ok: false, erro: "API do OSV fora do ar: " + e.message };
  }
}

// checagem diária (só script, sem IA): o que foi aprovado continua seguro?
export async function alertas({ aprovadosArq, agora = new Date(), fetcher = fetch, head = headRemoto, remover = true } = {}) {
  const { itens } = await lerAprovados(aprovadosArq);
  const watch = await lerJson(memoria("watchlist"), { repositorios: [] });
  const lista = [];
  const add = (a) => lista.push({ em: agora.toISOString(), ...a });
  // repositórios: commit novo = reauditar; sumiu = atenção
  for (const i of itens.filter((x) => x.tipo === "git")) {
    const nome = repoDaUrl(i.nome) ?? i.nome;
    const atual = await head(i.nome);
    if (!atual) add({ nivel: "atencao", item: nome, tipo: "git", motivo: "não consegui ver o repositório (apagado, privado ou sem internet)" });
    else if (atual !== i.versao) {
      // o Guard não fixa commit de repositório: até a reauditoria, sai da lista
      if (remover) await removerAprovado(aprovadosArq, { tipo: "git", nome: i.nome });
      add({ nivel: "reauditar", item: nome, tipo: "git", commit_auditado: i.versao, commit_novo: atual, motivo: "o repositório mudou desde a auditoria; saiu da lista do Guard até ser auditado de novo" });
    }
  }
  // repositórios clonados que estão na watchlist e não estão aprovados agora: só conferir se mudaram
  for (const w of watch.repositorios ?? []) {
    if (itens.some((i) => i.tipo === "git" && repoDaUrl(i.nome) === w.nome)) continue;
    if (lista.some((a) => a.item === w.nome)) continue;
    const atual = await head(`https://github.com/${w.nome}.git`);
    if (atual && atual !== w.commit) add({ nivel: "reauditar", item: w.nome, tipo: "git", commit_auditado: w.commit, commit_novo: atual, motivo: "versão nova de um repositório que você clonou: não atualize antes da reauditoria" });
  }
  // pacotes: descontinuado/retirado ou falha conhecida = emergência
  const pacotes = itens.filter((x) => x.tipo === "npm" || x.tipo === "pypi");
  for (const p of pacotes) {
    const d = await dadosDoPacote({ tipo: p.tipo, pacote: p.nome, versao: p.versao }, { fetcher }).catch(() => null);
    if (!d) add({ nivel: "atencao", item: `${p.tipo}:${p.nome}@${p.versao}`, tipo: p.tipo, motivo: "não consegui consultar o registro" });
    else if (d.descontinuado) {
      if (remover) await removerAprovado(aprovadosArq, p);
      add({ nivel: "emergencia", item: `${p.tipo}:${p.nome}@${p.versao}`, tipo: p.tipo, motivo: "versão descontinuada ou retirada pelo autor: " + d.descontinuado });
    }
  }
  const f = await falhasConhecidas(pacotes, { fetcher });
  if (!f.ok) add({ nivel: "atencao", item: "pacotes aprovados", motivo: "não consegui conferir falhas conhecidas: " + f.erro });
  for (const a of f.achados ?? []) {
    const p = pacotes.find((x) => x.nome.toLowerCase() === String(a.nome).toLowerCase() && x.versao === a.versao);
    if (remover && p) await removerAprovado(aprovadosArq, p);
    const item = `${p?.tipo ?? "pacote"}:${a.nome}@${a.versao}`;
    if (!lista.some((x) => x.item === item && x.nivel === "emergencia"))
      add({ nivel: "emergencia", item, tipo: p?.tipo, motivo: "falha de segurança publicada depois da aprovação: " + a.id });
  }
  // kits com item que deixou de ser seguro: suspensos, com aviso
  const hist = await lerJson(memoria("historico"), { repositorios: {} });
  for (const k of await kitsSuspensos(hist, lista))
    add({ nivel: "atencao", item: "kit " + k.nome, motivo: `kit suspenso: o item ${k.item} não está mais aprovado` });
  const emergencias = lista.filter((a) => a.nivel === "emergencia");
  for (const e of emergencias) e.plano = await planoEmergencia(e, { agora });
  const r = { data: agora.toISOString(), conferidos: itens.length + (watch.repositorios?.length ?? 0), alertas: lista, emergencias: emergencias.length };
  await gravarJson(memoria("alertas"), r);
  await registrar({ acao: "alertas", conferidos: r.conferidos, alertas: lista.length, emergencias: emergencias.length }, agora);
  return r;
}

// Plano de emergência: SÓ orienta. Nunca apaga, desinstala, reverte ou revoga nada sozinho.
export async function planoEmergencia(alerta, { agora = new Date() } = {}) {
  const watch = await lerJson(memoria("watchlist"), { repositorios: [] });
  const nomeRepo = String(alerta.item).replace(/^(npm|pypi):/, "").replace(/[@=].*$/, "");
  const usos = (watch.repositorios ?? []).filter((w) => w.nome === alerta.item || w.nome === nomeRepo);
  const segredos = await lerJson(memoria("mapa-segredos"), { segredos: [] });
  const L = [];
  const c = (t) => `- [ ] ${t}`;
  L.push(`# 🚨 Plano de emergência · ${alerta.item}`, "", `${agora.toISOString().slice(0, 16).replace("T", " ")} (UTC) · motivo: ${alerta.motivo}`, "");
  L.push("> O Garimbot **não apaga, não desinstala, não reverte e não troca senha nenhuma sozinho**. Ele só tirou o item da lista do Guard e preparou este checklist. Cada passo é seu, com a sua confirmação; marque o que já fez.", "");
  L.push("## 1. Conter");
  L.push(c("Pausar o agendamento: `schtasks /Change /TN \"Garimbot\\Semanal\" /Disable` e `schtasks /Change /TN \"Garimbot\\Alertas\" /Disable`"));
  L.push(c("Pausar a ponte (painel › Ponte › Pausar) e os pedidos aos agentes até terminar"));
  L.push(c("Desativar a skill, plugin, MCP ou hook envolvido (tire do `.mcp.json` / `.claude/` do projeto)"));
  if (alerta.tipo === "npm") L.push(c(`Achar onde está instalado: \`npm ls ${nomeRepo}\` na pasta de cada projeto`));
  if (alerta.tipo === "pypi") L.push(c(`Achar onde está instalado: \`pip show ${nomeRepo}\``));
  L.push(c("Se ele chegou a rodar no seu PC: desligue o Wi-Fi ou o cabo enquanto confere"), "");
  L.push("## 2. Identificar o alcance");
  if (!usos.length) L.push("- Nenhum clone registrado na watchlist. Se você instalou por fora, confira os seus projetos (`node garimbot/scripts/garimbot.mjs projeto <pasta>` mostra o inventário e as dependências).");
  for (const u of usos)
    L.push(`- Quarentena: \`${u.pasta}\`${u.projeto ? ` · projeto \`${u.projeto}\`, branch \`${u.ramo}\`, ponto de restauração \`${u.ponto_de_restauracao}\`` : ""}`);
  L.push("- Confira também `garimbot/docs/TERCEIROS.md`, a watchlist e o histórico de auditorias (`garimbot/data/`).", "");
  L.push("## 3. Trocar credenciais (por prioridade; só nomes, nunca valores)");
  for (const s of segredos.segredos ?? []) L.push(c(`**${s.nome}** — ${s.onde}`));
  if (!segredos.segredos?.length) L.push("- Veja `garimbot/data/mapa-segredos.json`.");
  L.push("");
  L.push("## 4. Remover (só depois de conter; cada um com a sua confirmação)");
  if (alerta.tipo === "npm") L.push(c(`Desinstalar: \`npm uninstall ${nomeRepo}\` em cada projeto e conferir o \`package-lock.json\``));
  if (alerta.tipo === "pypi") L.push(c(`Desinstalar: \`pip uninstall ${nomeRepo}\` e tirar do \`requirements.txt\``));
  for (const u of usos) {
    L.push(c(`Apagar a cópia da quarentena: \`Remove-Item -Recurse "${u.pasta}"\``));
    if (u.projeto) L.push(c(`Voltar o projeto ao ponto anterior (confira antes com \`git -C "${u.projeto}" log ${u.ponto_de_restauracao} -1\`): \`git -C "${u.projeto}" switch -\` e apague o branch \`${u.ramo}\` se quiser`));
  }
  L.push("");
  L.push("## 5. Procurar sinais de invasão");
  for (const t of ["Commits desconhecidos, tokens, deploy keys ou webhooks novos no GitHub (Settings de cada repositório)", "Workflows do GitHub Actions alterados", "Regras do Firebase ou da Cloudflare modificadas", "Gastos ou uso fora do normal nas contas de nuvem e de API", "MCPs, hooks, `CLAUDE.md`, `settings.json` ou agentes alterados sem você (`git status` e `git log` na pasta da agência)", "Tarefas agendadas desconhecidas (`Get-ScheduledTask | Where-Object TaskPath -notlike \"\\Microsoft*\"`)", "Varredura completa do Windows Defender: `Start-MpScan -ScanType FullScan`"])
    L.push(c(t));
  L.push("");
  L.push("## 6. Recuperar");
  L.push(c("Restaurar do ponto de restauração ou do backup (painel › Projetos)"), c("Auditar de novo os projetos afetados (`projeto <pasta>`)"), c("Só então reativar a ponte, os agentes e o agendamento (`schtasks /Change ... /Enable`)"), "");
  L.push("## 7. Registrar e aprender");
  L.push(c("O item já está na lista de bloqueio do Garimbot"), c("Avise o Guardião: Serviços & setores › Comando & Controle › Guardião, com este arquivo"), c("Peça ao Garimbot uma regra ou teste novo para pegar o mesmo padrão (a taxa de acerto confere se continua detectando)"), "");
  const arq = path.join(DATA, "incidentes", `${agora.toISOString().slice(0, 10)}-${pastaDoRepo(alerta.item)}.md`);
  await mkdir(path.dirname(arq), { recursive: true });
  await writeFile(arq, L.join("\n"));
  await registrar({ acao: "plano-emergencia", item: alerta.item, arquivo: path.relative(DATA, arq) }, agora);
  return arq;
}
