// Fase 3: resumo semanal e notificações. E-mail pelo Resend e sino do painel
// só quando configurados no ambiente do PC (.env, nunca no Git):
//   RESEND_API_KEY, GARIMBOT_EMAIL (destinatário), GARIMBOT_EMAIL_DE (remetente verificado)
//   GARIMBOT_PAINEL_URL e GARIMBOT_PAINEL_TOKEN (relatório de robô no painel)
// Sem configuração, nada sai do computador: o resumo fica em relatorios/semanal/.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { lerJson, memoria, DATA } from "./base.mjs";

const dentro = (iso, desde) => iso && Date.parse(iso) >= desde;
const br = (d) => d.toISOString().slice(0, 10).split("-").reverse().join("/");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function resumoSemanal({ agora = new Date(), notaDestaque = 85 } = {}) {
  const desde = agora.getTime() - 7 * 864e5;
  const uso = await lerJson(memoria("uso"), { execucoes: [] });
  const hist = await lerJson(memoria("historico"), { repositorios: {} });
  const al = await lerJson(memoria("alertas"), { alertas: [] });
  const execs = uso.execucoes.filter((e) => dentro(e.data, desde));
  const decididos = Object.entries(hist.repositorios ?? {}).filter(([, h]) => dentro(h.data, desde));
  const aprovados = decididos.filter(([, h]) => h.resultado === "APROVADO");
  const destaques = aprovados.filter(([, h]) => (h.nota ?? 0) >= notaDestaque);
  const incidentes = (await readdir(path.join(DATA, "incidentes")).catch(() => [])).filter((f) => f.endsWith(".md") && f.slice(0, 10) >= new Date(desde).toISOString().slice(0, 10));
  const r = {
    periodo: `${br(new Date(desde))} a ${br(agora)}`,
    execucoes: execs.length,
    auditados: execs.reduce((s, e) => s + (e.auditados ?? 0), 0),
    minutos: Math.round(execs.reduce((s, e) => s + (e.minutos ?? 0), 0) * 10) / 10,
    aprovados: aprovados.map(([n, h]) => ({ nome: n, nota: h.nota ?? null })),
    reprovados: decididos.length - aprovados.length,
    destaques: destaques.map(([n, h]) => ({ nome: n, nota: h.nota })),
    alertas: (al.alertas ?? []).filter((a) => dentro(a.em, desde)),
    incidentes,
  };
  r.status = r.incidentes.length || r.alertas.some((a) => a.nivel === "emergencia") ? "falhou" : r.alertas.length ? "atencao" : "ok";
  return r;
}

export function resumoMd(r) {
  const L = [`# Garimbot · resumo da semana (${r.periodo})`, ""];
  L.push(`- Execuções: ${r.execucoes} · auditados: ${r.auditados} · tempo: ${r.minutos} min`);
  L.push(`- Aprovados: **${r.aprovados.length}** · reprovados: ${r.reprovados}`);
  L.push(`- Alertas: ${r.alertas.length} · emergências: ${r.incidentes.length}`, "");
  if (r.destaques.length) L.push("## ⭐ Destaques (nota alta)", "", ...r.destaques.map((d) => `- ${d.nome} — nota ${d.nota}`), "");
  if (r.aprovados.length) L.push("## Aprovados", "", ...r.aprovados.map((d) => `- ${d.nome}${d.nota != null ? " — nota " + d.nota : ""}`), "");
  if (r.alertas.length) L.push("## Alertas", "", ...r.alertas.map((a) => `- [${a.nivel}] ${a.item}: ${a.motivo}`), "");
  if (r.incidentes.length) L.push("## 🚨 Planos de emergência", "", ...r.incidentes.map((f) => `- garimbot/data/incidentes/${f}`), "");
  if (!r.execucoes && !r.alertas.length) L.push("Semana sem execuções. Confira o agendamento (`node garimbot/scripts/garimbot.mjs agendar`).");
  return L.join("\n") + "\n";
}

// envia o que estiver configurado; devolve o que foi feito (sem mostrar segredos)
export async function avisar(r, { env = process.env, fetcher = fetch, assunto } = {}) {
  const feito = [];
  if (env.RESEND_API_KEY && env.GARIMBOT_EMAIL && env.GARIMBOT_EMAIL_DE) {
    // o envio usa a mesma biblioteca do `npm run email:send` (só carregada aqui: o sandbox não tem)
    const { prepareEmail, sendEmails } = await import("../../../tools/lib/email.mjs");
    const lista = (t, xs) => (xs.length ? `<h3>${t}</h3><ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
    const html =
      `<h2>⛏ Garimbot · ${esc(r.periodo)}</h2><p>${r.execucoes} execução(ões) · ${r.auditados} auditado(s) · <b>${r.aprovados.length} aprovado(s)</b> · ${r.reprovados} reprovado(s) · ${r.alertas.length} alerta(s)</p>` +
      lista("⭐ Destaques", r.destaques.map((d) => `${d.nome} — nota ${d.nota}`)) +
      lista("🚨 Emergências", r.incidentes) +
      lista("Alertas", r.alertas.map((a) => `${a.item}: ${a.motivo}`)) +
      `<p style="color:#667">Detalhes em garimbot/relatorios/ na pasta da agência.</p>`;
    const p = prepareEmail({ tipo: "transacional", de: env.GARIMBOT_EMAIL_DE, para: [env.GARIMBOT_EMAIL], assunto: assunto ?? `Garimbot: ${r.aprovados.length} aprovado(s), ${r.alertas.length} alerta(s)`, html, texto: resumoMd(r) });
    if (p.errors.length) feito.push("e-mail não enviado: " + p.errors.join("; "));
    else
      await sendEmails(p.payloads, { apiKey: env.RESEND_API_KEY, fetch: fetcher }).then(
        () => feito.push("e-mail enviado"),
        (e) => feito.push("e-mail falhou: " + String(e.message).slice(0, 160)),
      );
  } else feito.push("e-mail não configurado");
  if (env.GARIMBOT_PAINEL_URL && env.GARIMBOT_PAINEL_TOKEN && /^https:\/\//.test(env.GARIMBOT_PAINEL_URL)) {
    const corpo = {
      robo: "garimbot",
      status: r.status,
      origem: "agendado",
      resumo: `${r.aprovados.length} aprovado(s), ${r.reprovados} reprovado(s), ${r.alertas.length} alerta(s), ${r.incidentes.length} emergência(s) (${r.periodo}).`,
      achados: [
        ...r.incidentes.map((f) => ({ severidade: "critica", categoria: "garimbot", titulo: "Plano de emergência: " + f.slice(11, -3), arquivo: "garimbot/data/incidentes/" + f, status: "aberto" })),
        ...r.destaques.map((d) => ({ severidade: "baixa", categoria: "garimbot", titulo: `Destaque aprovado: ${d.nome} (nota ${d.nota})`, status: "info" })),
      ].slice(0, 30),
    };
    try {
      const res = await fetcher(env.GARIMBOT_PAINEL_URL.replace(/\/$/, "") + "/robos/relatorio", { method: "POST", headers: { Authorization: "Bearer " + env.GARIMBOT_PAINEL_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
      feito.push(res.ok ? "painel avisado" : "painel respondeu " + res.status);
    } catch (e) {
      feito.push("painel fora do ar: " + String(e.message).slice(0, 120));
    }
  } else feito.push("painel não configurado");
  return feito;
}
