import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY, ALLOWED_EMAIL } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const DEFAULT_RUBRIC = { competenze: 1.7, abilita: 3.1, conoscenze: 1.2 };

// Stato globale dell'app
const state = {
  user: null,
  years: [],
  currentYearId: null,
  classes: [],
  currentClassId: null,
  enrollments: [], // include student
  observations: [],
  evaluations: [],
  plannedAssessments: [],
  absences: [],
  lessonPlans: [],
  selectedRubric: { ...DEFAULT_RUBRIC },
  evalViewMode: "calendar" // "calendar" oppure "grid"
};

const QUICK_NEGATIVE_TAGS = [
  "Senza DPI / Camice",
  "Aiuto continuo",
  "Distrazione / Smartphone",
  "Errore quota / Tolleranza",
  "Postazione disordinata",
  "Ciclo / Parametri errati"
];

// ============================================================================
// UTILITY UI
// ============================================================================
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { el.style.display = "none"; }, 2600);
}

function roundMastercom(val) {
  // Arrotonda al mezzo voto più vicino (es. 5.7 -> 5.5, 5.8 -> 6.0)
  return (Math.round(val * 2) / 2).toFixed(2);
}

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function getMachinesForGrade(grade) {
  return grade === 3
    ? ["Tornio 1", "Tornio 2", "Tornio 3", "Saldatrice 1", "Saldatrice 2"]
    : ["Tornio 1", "Tornio 2", "Tornio 3", "Fresatrice"];
}

function formatDateKey(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return String(dateInput).slice(0, 10);
  return d.toISOString().split("T")[0];
}

function formatDateLabelIT(isoDate) {
  const parts = String(isoDate).split("-");
  if (parts.length !== 3) return isoDate;
  const [y, m, d] = parts;
  const dateObj = new Date(Number(y), Number(m) - 1, Number(d));
  return dateObj.toLocaleDateString("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function getStudentObservationsText(enrollmentId) {
  const list = state.observations.filter(o => o.enrollment_id === enrollmentId);
  if (list.length === 0) return "";
  return list
    .map(o => `${o.tag} (${new Date(o.observed_at).toLocaleDateString("it-IT")})`)
    .join(" • ");
}

// ============================================================================
// AUTENTICAZIONE PRIVATA
// ============================================================================
async function initAuth() {
  supabase.auth.onAuthStateChange((_event, session) => {
    handleSession(session);
  });

  const btnGoogle = document.getElementById("btn-login-google");
  if (btnGoogle) {
    btnGoogle.onclick = () =>
      supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href } });
  }

  const btnLogout = document.getElementById("btn-logout");
  if (btnLogout) {
    btnLogout.onclick = () => supabase.auth.signOut();
  }
}

async function handleSession(session) {
  const loginScreen = document.getElementById("login-screen");
  const appShell = document.getElementById("app-shell");
  const loginErr = document.getElementById("login-error");

  if (!session) {
    state.user = null;
    loginScreen.classList.remove("hidden");
    appShell.classList.add("hidden");
    return;
  }

  if (ALLOWED_EMAIL && ALLOWED_EMAIL !== "tua.email@esempio.it" && session.user.email !== ALLOWED_EMAIL) {
    await supabase.auth.signOut();
    if (loginErr) loginErr.textContent = "Accesso negato: account non autorizzato.";
    return;
  }

  const alreadyLoaded = state.user && state.user.id === session.user.id;
  state.user = session.user;
  loginScreen.classList.add("hidden");
  appShell.classList.remove("hidden");

  if (!alreadyLoaded) {
    await bootstrapData();
  }
}

// ============================================================================
// CARICAMENTO INIZIALE DATI
// ============================================================================
async function bootstrapData() {
  const { data: years, error } = await supabase
    .from("school_years")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    showToast("Errore caricamento anni: " + error.message);
    return;
  }

  state.years = years || [];
  if (state.years.length > 0) {
    const current = state.years.find(y => y.is_current) || state.years[0];
    state.currentYearId = current.id;
  }
  renderYearSelectors();
  await loadClassesForYear();
  await loadLessonPlans();
}

function renderYearSelectors() {
  const sel = document.getElementById("select-year");
  const promSel = document.getElementById("promote-target-year");
  if (sel) sel.innerHTML = "";
  if (promSel) promSel.innerHTML = "";

  if (state.years.length === 0) {
    if (sel) sel.innerHTML = `<option value="">Nessun anno (crealo in Classi)</option>`;
    return;
  }
  state.years.forEach(y => {
    if (sel) sel.innerHTML += `<option value="${y.id}" ${y.id === state.currentYearId ? "selected" : ""}>${y.label}</option>`;
    if (promSel) promSel.innerHTML += `<option value="${y.id}">${y.label}</option>`;
  });
}

async function loadClassesForYear() {
  const classSel = document.getElementById("select-class");
  if (classSel) classSel.innerHTML = "";

  if (!state.currentYearId) {
    state.classes = [];
    state.currentClassId = null;
    renderAllViews();
    return;
  }

  const { data: classes, error } = await supabase
    .from("classes")
    .select("*")
    .eq("school_year_id", state.currentYearId)
    .order("name", { ascending: true });

  if (error) {
    showToast("Errore caricamento classi: " + error.message);
    return;
  }

  state.classes = classes || [];
  if (state.classes.length > 0) {
    if (!state.classes.some(c => c.id === state.currentClassId)) {
      state.currentClassId = state.classes[0].id;
    }
    state.classes.forEach(c => {
      if (classSel) {
        classSel.innerHTML += `<option value="${c.id}" ${c.id === state.currentClassId ? "selected" : ""}>Classe ${c.name}</option>`;
      }
    });
  } else {
    state.currentClassId = null;
    if (classSel) classSel.innerHTML = `<option value="">Nessuna classe</option>`;
  }

  await loadClassDetails();
}

async function loadClassDetails() {
  if (!state.currentClassId) {
    state.enrollments = [];
    state.observations = [];
    state.evaluations = [];
    state.plannedAssessments = [];
    state.absences = [];
    renderAllViews();
    return;
  }

  const { data: enrollments, error } = await supabase
    .from("enrollments")
    .select("*, students(*)")
    .eq("class_id", state.currentClassId)
    .eq("status", "attivo");

  if (error) {
    showToast("Errore caricamento studenti: " + error.message);
    return;
  }

  state.enrollments = (enrollments || []).sort((a, b) =>
    a.students.last_name.localeCompare(b.students.last_name)
  );

  const enrIds = state.enrollments.map(e => e.id);

  if (enrIds.length > 0) {
    const [obsRes, evalRes, absRes] = await Promise.all([
      supabase.from("observations").select("*").in("enrollment_id", enrIds).order("observed_at", { ascending: false }),
      supabase.from("evaluations").select("*").in("enrollment_id", enrIds).order("evaluated_at", { ascending: false }),
      supabase.from("absences").select("*").in("enrollment_id", enrIds).order("created_at", { ascending: false })
    ]);
    state.observations = obsRes.data || [];
    state.evaluations = evalRes.data || [];
    state.absences = absRes.data || [];
  } else {
    state.observations = [];
    state.evaluations = [];
    state.absences = [];
  }

  const { data: plans } = await supabase
    .from("planned_assessments")
    .select("*")
    .eq("class_id", state.currentClassId)
    .order("due_date", { ascending: true });
  state.plannedAssessments = plans || [];

  renderAllViews();
}

function getFilteredEnrollments() {
  const grp = document.getElementById("select-group")?.value || "ALL";
  const query = (document.getElementById("search-student")?.value || "").trim().toLowerCase();
  return state.enrollments.filter(e => {
    if (grp !== "ALL" && e.lab_group !== grp) return false;
    if (query) {
      const full = `${e.students.last_name} ${e.students.first_name}`.toLowerCase();
      if (!full.includes(query)) return false;
    }
    return true;
  });
}

function renderAllViews() {
  renderOfficinaList();
  renderEvaluationsList();
  renderPlannedList();
  renderCdcSummary();
}

// ============================================================================
// TAB 1: OFFICINA 1-TAP
// ============================================================================
function renderOfficinaList() {
  const container = document.getElementById("officina-student-list");
  if (!container) return;
  const list = getFilteredEnrollments();

  if (list.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);">Nessuno studente trovato. Vai su <strong>Classi &amp; Promozioni</strong> per importare gli elenchi.</p>`;
    return;
  }

  const subj = document.getElementById("officina-subject")?.value || "Tecnologia";

  container.innerHTML = list.map(enr => {
    const st = enr.students;
    const stObs = state.observations.filter(o => o.enrollment_id === enr.id && o.subject === subj);
    const stEvals = state.evaluations.filter(ev => ev.enrollment_id === enr.id && ev.subject === subj);
    const lastGrade = stEvals.length > 0 ? stEvals[0].mastercom_grade : null;

    return `
      <div class="student-item" style="flex-direction:column; align-items:stretch;">
        <div class="row" style="justify-content:space-between;">
          <div>
            <span class="student-name">${st.last_name} ${st.first_name}</span>
            <span class="student-meta">(${enr.lab_group})</span>
            ${stObs.length > 0 ? `<span class="badge badge-red">${stObs.length} negativi</span>` : `<span class="badge badge-green">0 negativi</span>`}
            ${lastGrade ? `<span class="badge badge-amber">Ultimo: ${lastGrade}</span>` : ""}
          </div>
          <div class="row">
            <button class="btn btn-outline btn-sm" onclick="window.toggleTags('${enr.id}')">+ Negativo</button>
            <button class="btn btn-primary btn-sm" onclick="window.openEvalForStudent('${enr.id}')">📋 Griglia</button>
          </div>
        </div>
        <div id="tags-${enr.id}" class="quick-tags hidden">
          ${QUICK_NEGATIVE_TAGS.map(t => `<button class="tag-btn" onclick="window.addQuickNegative('${enr.id}', '${t}')">${t}</button>`).join("")}
        </div>
        ${stObs.length > 0 ? `
          <div style="font-size:0.78rem; color:var(--danger); margin-top:4px;">
            Recenti (${subj}): ${stObs.slice(0, 3).map(o => `${o.tag} (${new Date(o.observed_at).toLocaleDateString("it-IT")})`).join(" • ")}
          </div>` : ""}
      </div>
    `;
  }).join("");
}

window.toggleTags = (enrId) => {
  const el = document.getElementById(`tags-${enrId}`);
  if (el) el.classList.toggle("hidden");
};

window.addQuickNegative = async (enrId, tag) => {
  const subject = document.getElementById("officina-subject")?.value || "Tecnologia";
  const { error } = await supabase.from("observations").insert({
    owner_id: state.user.id,
    enrollment_id: enrId,
    subject,
    tag
  });
  if (error) {
    showToast("Errore salvataggio: " + error.message);
    return;
  }
  showToast(`Segnato "${tag}" (${subject})`);
  await loadClassDetails();
};

// ============================================================================
// TAB 2 & MODALE: VALUTAZIONI GRIGLIA DIPARTIMENTO + CALENDARIO + PDF
// ============================================================================
function resetRubricSelection() {
  state.selectedRubric = { ...DEFAULT_RUBRIC };
  document.querySelectorAll(".rubric-options").forEach(groupEl => {
    const groupName = groupEl.dataset.group;
    const defaultVal = DEFAULT_RUBRIC[groupName];
    groupEl.querySelectorAll(".rubric-opt").forEach(optEl => {
      const isDefault = parseFloat(optEl.dataset.val) === defaultVal;
      optEl.classList.toggle("selected", isDefault);
    });
  });
}

window.openEvalForStudent = (enrId = null) => {
  const modal = document.getElementById("eval-modal-backdrop");
  const sel = document.getElementById("eval-student-select");
  sel.innerHTML = state.enrollments.map(e =>
    `<option value="${e.id}" ${e.id === enrId ? "selected" : ""}>${e.students.last_name} ${e.students.first_name}</option>`
  ).join("");

  document.getElementById("eval-subject-select").value = document.getElementById("officina-subject")?.value || "Tecnologia";
  document.getElementById("eval-date-input").value = todayISO();
  document.getElementById("eval-title-input").value = "";
  document.getElementById("eval-notes-input").value = "";
  document.getElementById("eval-synced-checkbox").checked = false;

  resetRubricSelection();
  updateModalNegativesPreview();
  recalcRubricTotal();
  modal.style.display = "flex";
};

function updateModalNegativesPreview() {
  const enrId = document.getElementById("eval-student-select")?.value;
  const subj = document.getElementById("eval-subject-select")?.value;
  const listEl = document.getElementById("eval-negatives-list");
  if (!listEl) return;
  const obs = state.observations.filter(o => o.enrollment_id === enrId && o.subject === subj);

  if (obs.length === 0) {
    listEl.textContent = "Nessun negativo registrato in laboratorio per questa materia.";
  } else {
    listEl.innerHTML = obs.map(o =>
      `• <strong>${o.tag}</strong> (${new Date(o.observed_at).toLocaleDateString("it-IT")})`
    ).join("<br>");
  }
}

function recalcRubricTotal() {
  const sum = Number((
    state.selectedRubric.competenze +
    state.selectedRubric.abilita +
    state.selectedRubric.conoscenze
  ).toFixed(1));
  document.getElementById("eval-sum-display").textContent = sum.toFixed(1);
  document.getElementById("eval-mastercom-display").textContent = roundMastercom(sum);
}

async function saveEvaluation(andPrint = false) {
  const enrId = document.getElementById("eval-student-select").value;
  if (!enrId) return showToast("Seleziona uno studente.");
  const subject = document.getElementById("eval-subject-select").value;
  const title = document.getElementById("eval-title-input").value.trim() || `Prova ${subject}`;
  const term = document.getElementById("eval-term-select").value;
  const evaluated_at = document.getElementById("eval-date-input").value || todayISO();
  const synced = document.getElementById("eval-synced-checkbox").checked;
  const notes = document.getElementById("eval-notes-input").value.trim();

  const total_score = Number((
    state.selectedRubric.competenze +
    state.selectedRubric.abilita +
    state.selectedRubric.conoscenze
  ).toFixed(1));
  const mastercom_grade = Number(roundMastercom(total_score));

  const obs = state.observations.filter(o => o.enrollment_id === enrId && o.subject === subject);
  const linked_negatives_summary = obs.map(o => `${o.tag} (${new Date(o.observed_at).toLocaleDateString("it-IT")})`).join("; ");

  const payload = {
    owner_id: state.user.id,
    enrollment_id: enrId,
    subject,
    term,
    title,
    competenze_score: state.selectedRubric.competenze,
    abilita_score: state.selectedRubric.abilita,
    conoscenze_score: state.selectedRubric.conoscenze,
    total_score,
    mastercom_grade,
    synced_to_mastercom: synced,
    linked_negatives_summary,
    notes,
    evaluated_at
  };

  const { data, error } = await supabase.from("evaluations").insert(payload).select().single();
  if (error) {
    showToast("Errore salvataggio: " + error.message);
    return;
  }

  document.getElementById("eval-modal-backdrop").style.display = "none";
  showToast("Valutazione salvata con Griglia Dipartimento!");
  await loadClassDetails();

  if (andPrint && data) {
    window.printEvaluationPDF(data.id);
  }
}

function renderEvaluationsList() {
  const container = document.getElementById("evaluations-list");
  if (!container) return;
  const filterSubj = document.getElementById("filter-eval-subject")?.value || "ALL";

  const filteredEvals = state.evaluations.filter(
    ev => filterSubj === "ALL" || ev.subject === filterSubj
  );

  const eventsByDate = new Map();
  const ensureDay = (dateKey) => {
    if (!eventsByDate.has(dateKey)) {
      eventsByDate.set(dateKey, { evals: [], obs: [] });
    }
    return eventsByDate.get(dateKey);
  };

  filteredEvals.forEach(ev => {
    ensureDay(formatDateKey(ev.evaluated_at)).evals.push(ev);
  });

  state.observations.forEach(ob => {
    ensureDay(formatDateKey(ob.observed_at)).obs.push(ob);
  });

  if (state.evalViewMode === "calendar") {
    const sortedDates = Array.from(eventsByDate.keys()).sort((a, b) => b.localeCompare(a));

    if (sortedDates.length === 0) {
      container.innerHTML = `<p style="color:var(--muted);">Nessun evento a calendario per questa classe.</p>`;
      return;
    }

    container.innerHTML = `
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(290px, 1fr)); gap:12px;">
        ${sortedDates.map(dateKey => {
          const dayData = eventsByDate.get(dateKey);
          return `
            <div class="card" style="margin:0; padding:12px; border:1px solid var(--border); border-radius:10px; background:#fff;">
              <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:6px; margin-bottom:8px;">
                <strong style="text-transform:capitalize;">${formatDateLabelIT(dateKey)}</strong>
                <span class="badge badge-amber">${dayData.evals.length} voti • ${dayData.obs.length} note</span>
              </div>

              ${dayData.evals.map(ev => {
                const enr = state.enrollments.find(e => e.id === ev.enrollment_id);
                const stName = enr ? `${enr.students.last_name} ${enr.students.first_name}`.trim() : "Studente";
                const allObs = enr ? getStudentObservationsText(enr.id) : "";
                return `
                  <div style="padding:6px 0; border-bottom:1px dashed #e2e8f0;">
                    <div style="display:flex; justify-content:space-between; gap:6px;">
                      <strong>${stName}</strong>
                      <span class="badge badge-green">${ev.mastercom_grade}</span>
                    </div>
                    <div style="font-size:0.78rem; color:var(--muted);">${ev.subject} — ${ev.title}</div>
                    ${allObs ? `<div style="font-size:0.75rem; color:var(--danger); margin-top:2px;">Note: ${allObs}</div>` : ""}
                  </div>
                `;
              }).join("")}

              ${dayData.obs.map(ob => {
                const enr = state.enrollments.find(e => e.id === ob.enrollment_id);
                const stName = enr ? `${enr.students.last_name} ${enr.students.first_name}`.trim() : "Studente";
                return `
                  <div style="padding:6px 0; border-bottom:1px dashed #e2e8f0;">
                    <span class="badge badge-red">${ob.tag}</span>
                    <strong style="margin-left:4px;">${stName}</strong>
                    <div style="font-size:0.75rem; color:var(--muted);">${ob.subject}</div>
                  </div>
                `;
              }).join("")}
            </div>
          `;
        }).join("")}
      </div>
    `;
    return;
  }

  if (filteredEvals.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);">Nessuna valutazione registrata per questa selezione.</p>`;
    return;
  }

  container.innerHTML = filteredEvals.map(ev => {
    const enr = state.enrollments.find(e => e.id === ev.enrollment_id);
    const stName = enr ? `${enr.students.last_name} ${enr.students.first_name}`.trim() : "Studente";
    const studentObs = enr ? getStudentObservationsText(enr.id) : ev.linked_negatives_summary;

    return `
      <div class="student-item">
        <div>
          <div class="student-name">${stName} — <span style="color:var(--primary);">${ev.subject}: ${ev.title}</span></div>
          <div class="student-meta">
            Data: ${ev.evaluated_at} | Griglia: C=${ev.competenze_score} + A=${ev.abilita_score} + K=${ev.conoscenze_score} = <strong>${ev.total_score}/10</strong>
            &rarr; Mastercom: <strong>${ev.mastercom_grade}</strong>
          </div>
          ${studentObs ? `<div style="font-size:0.78rem; color:var(--danger); margin-top:2px;">Annotazioni laboratorio: ${studentObs}</div>` : ""}
        </div>
        <div class="row">
          <button class="btn btn-sm ${ev.synced_to_mastercom ? "btn-ok" : "btn-outline"}" onclick="window.toggleMastercomSync('${ev.id}', ${!ev.synced_to_mastercom})">
            ${ev.synced_to_mastercom ? "✓ Su Mastercom" : "Segna su Mastercom"}
          </button>
          <button class="btn btn-primary btn-sm" onclick="window.printEvaluationPDF('${ev.id}')">🖨️ PDF</button>
        </div>
      </div>
    `;
  }).join("");
}

window.toggleMastercomSync = async (evalId, newStatus) => {
  const { error } = await supabase.from("evaluations").update({ synced_to_mastercom: newStatus }).eq("id", evalId);
  if (error) {
    showToast("Errore aggiornamento: " + error.message);
    return;
  }
  await loadClassDetails();
};

window.printEvaluationPDF = (evalId) => {
  const ev = state.evaluations.find(x => x.id === evalId);
  if (!ev) return;
  const enr = state.enrollments.find(e => e.id === ev.enrollment_id);
  const cls = state.classes.find(c => c.id === state.currentClassId);
  const yr = state.years.find(y => y.id === state.currentYearId);

  const stName = enr ? `${enr.students.last_name} ${enr.students.first_name}`.trim() : "";
  const clsName = cls ? cls.name : "";
  const yrLabel = yr ? yr.label : "";

  const descComp = {
    0.6: "Inesistenti. Molto lacunose e frammentarie.",
    1.1: "Lacunose, superficiali.",
    1.7: "Semplici, ma adeguate, non sempre precise, sufficientemente estese.",
    2.4: "Precise ed esaurienti.",
    3.0: "Complete ed approfondite."
  };
  const descAbil = {
    1.0: "Molto lacunose e frammentarie. Quasi inesistenti anche con assistenza.",
    1.4: "Superficiali e imprecise: necessita di continua assistenza.",
    3.1: "Semplici, ma adeguate: necessita di saltuari aiuti.",
    4.0: "Precise ed esaurienti: possiede notevole autonomia.",
    5.0: "Complete ed approfondite: del tutto autonomo."
  };
  const descCon = {
    0.3: "Inesistenti. Molto lacunose e frammentarie.",
    0.6: "Limitate, superficiali e mnemoniche.",
    1.2: "Estese, semplici, con qualche carenza, ma adeguate.",
    1.6: "Precise ed esaurienti.",
    2.0: "Complete ed approfondite."
  };

  const compVal = Number(ev.competenze_score);
  const abilVal = Number(ev.abilita_score);
  const conVal = Number(ev.conoscenze_score);

  const printArea = document.getElementById("print-area");
  printArea.innerHTML = `
    <div style="border:2px solid #000; padding:14px;">
      <h2 style="text-align:center; margin:0 0 6px 0; font-size:13pt;">GRIGLIA PER LA VALUTAZIONE DELLE ATTIVITÀ DI LABORATORIO</h2>
      <p style="text-align:center; margin:0 0 12px 0; font-size:10pt;">Dipartimento di Meccanica — Anno Scolastico ${yrLabel}</p>
      <table class="print-table">
        <tr>
          <td><strong>Studente:</strong> ${stName}</td>
          <td><strong>Classe:</strong> ${clsName}</td>
          <td><strong>Data:</strong> ${ev.evaluated_at}</td>
        </tr>
        <tr>
          <td><strong>Materia:</strong> ${ev.subject}</td>
          <td colspan="2"><strong>Prova / Elaborato:</strong> ${ev.title} (${ev.term})</td>
        </tr>
      </table>

      <table class="print-table">
        <thead>
          <tr>
            <th style="width:32%;">INDICATORI</th>
            <th style="width:8%;">Max</th>
            <th style="width:48%;">LIVELLO DI PRESTAZIONE RAGGIUNTO</th>
            <th style="width:12%;">Punteggio</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Competenze</strong> inerenti l'interpretazione dei disegni, applicazione norme tecniche e sicurezza, stesura cicli di lavoro e calcolo parametri di taglio.</td>
            <td style="text-align:center;">3.0</td>
            <td class="highlight-cell">${descComp[compVal] || ""}</td>
            <td class="highlight-cell" style="text-align:center; font-size:12pt;">${compVal.toFixed(1)}</td>
          </tr>
          <tr>
            <td><strong>Abilità</strong> nell'uso della strumentazione, macchine utensili tradizionali e CN, pannelli pneumatici, uso CAD/software specifici e autonomia operativa.</td>
            <td style="text-align:center;">5.0</td>
            <td class="highlight-cell">${descAbil[abilVal] || ""}</td>
            <td class="highlight-cell" style="text-align:center; font-size:12pt;">${abilVal.toFixed(1)}</td>
          </tr>
          <tr>
            <td><strong>Conoscenze</strong> delle tecniche di misura, di programmazione, di controllo e dei parametri di taglio.</td>
            <td style="text-align:center;">2.0</td>
            <td class="highlight-cell">${descCon[conVal] || ""}</td>
            <td class="highlight-cell" style="text-align:center; font-size:12pt;">${conVal.toFixed(1)}</td>
          </tr>
          <tr>
            <td colspan="3" style="text-align:right;"><strong>PUNTEGGIO TOTALE GRIGLIA (su 10):</strong></td>
            <td style="text-align:center; font-size:12pt;"><strong>${Number(ev.total_score).toFixed(1)} / 10</strong></td>
          </tr>
          <tr>
            <td colspan="3" style="text-align:right;"><strong>VOTO PROPOSTO / APPROSSIMATO PER REGISTRO:</strong></td>
            <td class="highlight-cell" style="text-align:center; font-size:13pt;"><strong>${Number(ev.mastercom_grade).toFixed(2)}</strong></td>
          </tr>
        </tbody>
      </table>

      <div style="margin-top:12px; font-size:9.5pt; border:1px solid #000; padding:8px;">
        <strong>Osservazioni registrate in laboratorio:</strong> ${ev.linked_negatives_summary || "Nessun rilievo negativo."}
        ${ev.notes ? `<br><strong>Note docente:</strong> ${ev.notes}` : ""}
      </div>

      <div style="display:flex; justify-content:space-between; margin-top:26px; font-size:10pt;">
        <div>Firma del Docente ___________________________</div>
        <div>Firma Studente (per presa visione) ___________________________</div>
      </div>
    </div>
  `;

  window.print();
};

// ============================================================================
// TAB 3: PROVE MINIME
// ============================================================================
function renderPlannedList() {
  const container = document.getElementById("planned-list");
  if (!container) return;
  if (state.plannedAssessments.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);">Nessuna prova minima programmata per questa classe.</p>`;
    return;
  }
  container.innerHTML = state.plannedAssessments.map(p => {
    const doneCount = state.evaluations.filter(ev =>
      ev.subject === p.subject && ev.term === p.term && ev.title.toLowerCase() === p.title.toLowerCase()
    ).length;
    const totStudents = state.enrollments.length;
    return `
      <div class="student-item">
        <div>
          <strong>[${p.subject} - ${p.term}]</strong> ${p.title}
          ${p.due_date ? `<span class="student-meta">(Scadenza: ${p.due_date})</span>` : ""}
        </div>
        <span class="badge ${doneCount >= totStudents ? "badge-green" : "badge-amber"}">
          Valutati: ${doneCount} / ${totStudents}
        </span>
      </div>
    `;
  }).join("");
}

// ============================================================================
// TAB 4: CONSIGLIO DI CLASSE & IMPORT ASSENZE
// ============================================================================
function renderCdcSummary() {
  const container = document.getElementById("cdc-summary-table");
  if (!container) return;
  if (state.enrollments.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);">Seleziona una classe con studenti.</p>`;
    return;
  }

  const avgFor = (enrId, subj) => {
    const list = state.evaluations.filter(ev => ev.enrollment_id === enrId && ev.subject === subj);
    if (list.length === 0) return "-";
    const avg = list.reduce((acc, x) => acc + Number(x.mastercom_grade), 0) / list.length;
    return `${avg.toFixed(2)} (${list.length})`;
  };

  container.innerHTML = `
    <table style="width:100%; border-collapse:collapse; font-size:0.88rem;">
      <thead>
        <tr style="background:#f8fafc; border-bottom:2px solid var(--border); text-align:left;">
          <th style="padding:8px;">Studente</th>
          <th style="padding:8px;">Media Tec.</th>
          <th style="padding:8px;">Media Sis.</th>
          <th style="padding:8px;">Media Dis.</th>
          <th style="padding:8px;">Negativi Lab</th>
          <th style="padding:8px;">Ore Assenza</th>
          <th style="padding:8px;">Turni Lab Persi</th>
        </tr>
      </thead>
      <tbody>
        ${state.enrollments.map(enr => {
          const obsCount = state.observations.filter(o => o.enrollment_id === enr.id).length;
          const abs = state.absences.find(a => a.enrollment_id === enr.id);
          return `
            <tr style="border-bottom:1px solid var(--border);">
              <td style="padding:8px;"><strong>${enr.students.last_name} ${enr.students.first_name}</strong></td>
              <td style="padding:8px;">${avgFor(enr.id, "Tecnologia")}</td>
              <td style="padding:8px;">${avgFor(enr.id, "Sistemi")}</td>
              <td style="padding:8px;">${avgFor(enr.id, "Disegno")}</td>
              <td style="padding:8px;">${obsCount > 0 ? `<span class="badge badge-red">${obsCount}</span>` : "0"}</td>
              <td style="padding:8px;">${abs ? abs.hours_absent + " h" : "-"}</td>
              <td style="padding:8px;">${abs ? abs.lab_sessions_missed : "-"}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

// ============================================================================
// TAB 5: SCHEDE PREPARAZIONE LEZIONE
// ============================================================================
async function loadLessonPlans() {
  const { data, error } = await supabase.from("lesson_plans").select("*").order("created_at", { ascending: false });
  if (error) {
    showToast("Errore caricamento schede lezione: " + error.message);
    return;
  }
  state.lessonPlans = data || [];
  const container = document.getElementById("lesson-plans-list");
  if (!container) return;
  if (state.lessonPlans.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);">Nessuna scheda lezione salvata.</p>`;
    return;
  }
  container.innerHTML = state.lessonPlans.map(lp => `
    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <h2>[Classe ${lp.grade}ª - ${lp.subject}] ${lp.title}</h2>
      </div>
      <div class="grid-2" style="font-size:0.88rem;">
        <div><strong>1. Grezzi da preparare:</strong><br>${lp.raw_materials || "-"}</div>
        <div><strong>2. Utensili e strumenti:</strong><br>${lp.tools_setup || "-"}</div>
        <div><strong>3. Briefing 3 minuti:</strong><br>${lp.briefing_points || "-"}</div>
        <div style="background:var(--warn-bg); padding:8px; border-radius:8px;">
          <strong>4. Piano B (2-3 ragazzi senza macchina):</strong><br>${lp.overflow_task || "-"}
        </div>
      </div>
    </div>
  `).join("");
}

// ============================================================================
// EVENT LISTENERS PRINCIPALI
// ============================================================================
function bindEvents() {
  document.querySelectorAll("nav.tabs button").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("nav.tabs button").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.remove("hidden");
    };
  });

  document.getElementById("select-year").onchange = async (e) => {
    state.currentYearId = e.target.value;
    await loadClassesForYear();
  };
  document.getElementById("select-class").onchange = async (e) => {
    state.currentClassId = e.target.value;
    await loadClassDetails();
  };
  document.getElementById("select-group").onchange = renderOfficinaList;
  document.getElementById("officina-subject").onchange = renderOfficinaList;
  document.getElementById("search-student").oninput = renderOfficinaList;
  document.getElementById("filter-eval-subject").onchange = renderEvaluationsList;

  const btnCal = document.getElementById("btn-view-calendar");
  const btnGrid = document.getElementById("btn-view-grid");
  if (btnCal && btnGrid) {
    btnCal.onclick = () => {
      state.evalViewMode = "calendar";
      btnCal.classList.replace("btn-outline", "btn-primary");
      btnGrid.classList.replace("btn-primary", "btn-outline");
      renderEvaluationsList();
    };
    btnGrid.onclick = () => {
      state.evalViewMode = "grid";
      btnGrid.classList.replace("btn-outline", "btn-primary");
      btnCal.classList.replace("btn-primary", "btn-outline");
      renderEvaluationsList();
    };
  }

  document.getElementById("btn-open-new-eval").onclick = () => window.openEvalForStudent();
  document.getElementById("btn-close-eval-modal").onclick = () => {
    document.getElementById("eval-modal-backdrop").style.display = "none";
  };
  document.getElementById("eval-student-select").onchange = updateModalNegativesPreview;
  document.getElementById("eval-subject-select").onchange = updateModalNegativesPreview;

  document.querySelectorAll(".rubric-options").forEach(groupEl => {
    const groupName = groupEl.dataset.group;
    groupEl.querySelectorAll(".rubric-opt").forEach(optEl => {
      optEl.onclick = () => {
        groupEl.querySelectorAll(".rubric-opt").forEach(o => o.classList.remove("selected"));
        optEl.classList.add("selected");
        state.selectedRubric[groupName] = parseFloat(optEl.dataset.val);
        recalcRubricTotal();
      };
    });
  });

  document.getElementById("btn-save-eval").onclick = () => saveEvaluation(false);
  document.getElementById("btn-print-preview").onclick = () => saveEvaluation(true);

  document.getElementById("btn-add-plan").onclick = async () => {
    if (!state.currentClassId) return showToast("Seleziona prima una classe!");
    const title = document.getElementById("plan-title").value.trim();
    if (!title) return showToast("Inserisci il titolo della prova.");
    const { error } = await supabase.from("planned_assessments").insert({
      owner_id: state.user.id,
      class_id: state.currentClassId,
      subject: document.getElementById("plan-subject").value,
      term: document.getElementById("plan-term").value,
      title,
      due_date: document.getElementById("plan-date").value || null
    });
    if (error) return showToast("Errore salvataggio prova: " + error.message);
    document.getElementById("plan-title").value = "";
    showToast("Prova minima programmata!");
    await loadClassDetails();
  };

  document.getElementById("btn-import-absences").onclick = async () => {
    if (!state.currentClassId) return showToast("Seleziona prima una classe!");
    const raw = document.getElementById("cdc-import-text").value.trim();
    const cdcLabel = document.getElementById("cdc-label").value.trim() || "CdC";
    if (!raw) return;

    const lines = raw.split("\n");
    let matched = 0;

    for (const line of lines) {
      const parts = line.split(";").map(p => p.trim());
      if (parts.length < 2) continue;
      const namePart = parts[0].toLowerCase();
      const hours = parseFloat(parts[1]) || 0;
      const labMissed = parseInt(parts[2] || "0", 10) || 0;

      const found = state.enrollments.find(e => {
        const f1 = `${e.students.last_name} ${e.students.first_name}`.toLowerCase();
        const f2 = `${e.students.first_name} ${e.students.last_name}`.toLowerCase();
        return f1.includes(namePart) || f2.includes(namePart) || namePart.includes(e.students.last_name.toLowerCase());
      });

      if (found) {
        await supabase.from("absences").delete().eq("enrollment_id", found.id).eq("cdc_label", cdcLabel);
        const { error: insErr } = await supabase.from("absences").insert({
          owner_id: state.user.id,
          enrollment_id: found.id,
          cdc_label: cdcLabel,
          hours_absent: hours,
          lab_sessions_missed: labMissed
        });
        if (!insErr) matched++;
      }
    }

    showToast(`Importate assenze per ${matched} studenti (${cdcLabel}).`);
    await loadClassDetails();
  };
}

// ============================================================================
// AVVIO
// ============================================================================
bindEvents();
initAuth();
