// Agendamento do Garimbot no Agendador de Tarefas do Windows (o dono roda os
// comandos uma vez). Os horários vêm de config/agendamento.yml (fuso de
// Brasília = horário do PC). Execução agendada nunca clona para uso.
import path from "node:path";

const DIAS = { domingo: "SUN", segunda: "MON", terca: "TUE", "terça": "TUE", quarta: "WED", quinta: "THU", sexta: "FRI", sabado: "SAT", "sábado": "SAT" };
const hora = (h) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(h ?? ""))) throw new Error("Horário inválido em agendamento.yml: " + h);
  return h;
};

// tarefas do Agendador: [{ nome, comando }] (comandos para o PowerShell, prontos para colar)
export function tarefas(ag, agencia) {
  const pasta = path.win32.join(agencia.replace(/\//g, "\\"), "garimbot", "agendamento");
  const tr = (arq) => `'"${path.win32.join(pasta, arq)}"'`;
  const criar = (nome, arq, extra) => ({ nome, comando: `schtasks /Create /TN "Garimbot\\${nome}" /TR ${tr(arq)} ${extra} /F` });
  const lista = [];
  const freq = ag.frequencia ?? "semanal";
  if (freq === "semanal") lista.push(criar("Semanal", "semanal.cmd", `/SC WEEKLY /D ${DIAS[ag.dia] ?? "SUN"} /ST ${hora(ag.hora ?? "21:00")}`));
  else if (freq === "dias") {
    const d = (ag.dias ?? []).map((x) => DIAS[String(x).toLowerCase()]).filter(Boolean);
    if (!d.length) throw new Error('Em agendamento.yml, "dias" está vazio.');
    lista.push(criar("Semanal", "semanal.cmd", `/SC WEEKLY /D ${d.join(",")} /ST ${hora(ag.hora ?? "21:00")}`));
  } else if (freq === "diario") (ag.horarios?.length ? ag.horarios : [ag.hora ?? "21:00"]).forEach((h, i) => lista.push(criar("Diario" + (i + 1), "semanal.cmd", `/SC DAILY /ST ${hora(h)}`)));
  else if (freq !== "desligado") throw new Error("frequencia inválida em agendamento.yml: " + freq);
  if (ag.alerta_diario !== false) lista.push(criar("Alertas", "alertas.cmd", `/SC DAILY /ST ${hora(ag.alerta_hora ?? "07:00")}`));
  return lista;
}
export const desligar = (lista) => lista.map((t) => `schtasks /Delete /TN "Garimbot\\${t.nome}" /F`);
