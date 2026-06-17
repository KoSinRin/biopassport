"use strict";

/* ===================== КОНСТАНТЫ ===================== */
const OPEN_FIRST = true; // первая способность раскрыта по умолчанию
const PRICE_STARS = 20; // цена полного паспорта в Telegram Stars
// Бэкенд (Railway HTTP-сервер). Пусто → фронт работает в офлайн-режиме с фоллбэками/заглушкой.
const BACKEND_URL = "https://biopassport-production.up.railway.app";
const STRESS = /[?&#]stress/i.test(location.search + location.hash); // ?stress — длинные тексты для теста вёрстки
const LONG_DEMO = "Расширенное демо-описание для стресс-теста вёрстки. Меланин радужной оболочки работает как встроенный светофильтр: он рассеивает часть коротковолнового излучения и снижает блики в яркий полдень. У носителей этого маркера обычно выше контрастная чувствительность на солнце, но ниже — в сумерках. Этот абзац намеренно длинный, чтобы проверить переносы строк, межстрочный интервал и корректность экспорта карточки в PNG при большом объёме контента.";
function descOf(p){ return STRESS ? (p.desc + " " + LONG_DEMO) : p.desc; }

/* ===================== СОСТОЯНИЕ ===================== */
const state = { step:-1, answers:{}, premium:false, pstep:0 };
// step: -1 welcome, 0..N вопросы, N "issuing", N+1 паспорт
// premium:true → доп.флоу по premiumOrder; pstep — шаг внутри премиум-фазы
const $app = document.getElementById("app");
let tg = null;

/* Telegram WebApp SDK — подгружаем мягко: в обычном браузере просто не загрузится */
(function loadTG(){
  try{
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-web-app.js";
    s.onload = function(){
      try{
        tg = window.Telegram && window.Telegram.WebApp;
        if(tg){
          tg.ready();
          tg.expand();
          if(tg.setHeaderColor) tg.setHeaderColor('#0B1411');
          if(tg.setBackgroundColor) tg.setBackgroundColor('#0B1411');
        }
      }catch(e){}
    };
    s.onerror = function(){};
    document.head.appendChild(s);
  }catch(e){}
})();

/* ===================== УТИЛИТЫ ===================== */
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(()=>t.classList.remove("show"), 2200);
}

const TRANSLIT = {"а":"A","б":"B","в":"V","г":"G","д":"D","е":"E","ё":"E","ж":"ZH","з":"Z","и":"I","й":"Y","к":"K","л":"L","м":"M","н":"N","о":"O","п":"P","р":"R","с":"S","т":"T","у":"U","ф":"F","х":"KH","ц":"TS","ч":"CH","ш":"SH","щ":"SCH","ъ":"","ы":"Y","ь":"","э":"E","ю":"YU","я":"YA"};
function translit(s){
  return String(s).toLowerCase().replace(/ /g,"<").split("").map(c => TRANSLIT[c] !== undefined ? TRANSLIT[c] : c.toUpperCase()).join("").replace(/[^A-Z0-9<]/g,"");
}
function mrzPad(s, n){ s = s.slice(0, n); while(s.length < n) s += "<"; return s; }

/* ===================== РАСЧЁТ РЕЗУЛЬТАТА ===================== */
function buildResult(full){
  const a = state.answers;
  // full → бесплатные + премиум-маркеры; иначе только бесплатные
  const keys = full ? DB.order.concat(DB.premiumOrder) : DB.order;
  const picked = keys.map(k => DB.markers[k].options.find(o => o.id === a[k])).filter(Boolean);
  const powers = keys.map(k => {
    const o = DB.markers[k].options.find(x => x.id === a[k]);
    return (o && o.power) ? { emoji: DB.markers[k].emoji, ...o.power } : null;
  }).filter(Boolean);
  const p = picked.reduce((acc,o) => acc * o.freq, 1);
  const oneIn = Math.max(2, Math.round(1/p));
  const tier = DB.rarityTiers.find(t => oneIn <= t.max).name;
  const typeName = (DB.typeAdj[a.eyes] || "Базовый") + " " + (DB.typeNoun[a.blood] || "Носитель");
  const totem = DB.totem[a.body] || "🧬";
  const name = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.first_name)
    ? tg.initDataUnsafe.user.first_name.toUpperCase() : "ПРЕДЪЯВИТЕЛЬ";
  // Номер и дату фиксируем при первом построении — чтобы полный паспорт сохранял идентичность базового
  const num = (state.result && state.result.num) || ("BIO-" + String(1000000 + Date.now() % 9000000).slice(0,7));
  const d = new Date();
  const date = (state.result && state.result.date)
    || [String(d.getDate()).padStart(2,"0"), String(d.getMonth()+1).padStart(2,"0"), d.getFullYear()].join(".");
  const mrz1 = mrzPad("P<BIO<" + translit(typeName) + "<<" + translit(name), 30);
  const mrz2 = mrzPad(num.replace("-","") + "<" + date.replace(/\./g,"") + "<1IN" + oneIn, 30);
  return { name, num, date, typeName, totem, tier, oneIn, powers, mrz1, mrz2 };
}

/* ===================== ЭКРАНЫ ===================== */
function render(){
  if(state.step === -1) return renderWelcome();
  if(!state.premium){
    const n = DB.order.length;
    if(state.step < n)   return renderQuestion(state.step, false);
    if(state.step === n) return renderIssuing(false);
    return renderPassport(false);
  }
  // ── премиум-фаза ──
  const pn = DB.premiumOrder.length;
  if(state.pstep < pn)   return renderQuestion(state.pstep, true);
  if(state.pstep === pn) return renderIssuing(true);
  renderPassport(true);
}

function renderWelcome(){
  $app.innerHTML = `
    <div class="screen welcome">
      <div class="hero">
        <div class="emblem">🧬</div>
        <h1 class="title">БИОПАСПОРТ</h1>
        <div class="title-sub">BIOLOGICAL PASSPORT</div>
        <p class="tagline">Не медкарта — твоя биологическая визитка.</p>
        <p class="lede">В тебе зашиты способности, которых нет у большинства. Ответь на 6 вопросов — и узнай свой биологический класс и редкость своей комбинации.</p>
      </div>

      <div class="preview" aria-hidden="true">
        <div class="preview-tag">образец документа</div>
        <div class="card mini">
          <div class="card-cover">
            <div class="l">
              <span class="dna">🧬</span>
              <div>
                <div class="t1">БИОПАСПОРТ</div>
                <div class="t2">BIOLOGICAL PASSPORT</div>
              </div>
            </div>
            <div class="num">№ БП-0000</div>
          </div>
          <div class="card-paper">
            <div class="f-label">Тип носителя / Carrier type</div>
            <div class="holder-type" style="padding-right:0"><span>🐺</span>Огненный Алхимик</div>
            <hr class="rule">
            <div class="f-label">Редкость комбинации / Rarity</div>
            <div class="rarity" style="padding-right:0">★ ЛЕГЕНДАРНАЯ<small>такой набор — у 1 из 32 000 людей</small></div>
            <div class="mini-powers">
              <span>👁 Волчий взгляд</span>
              <span>🩸 Универсальный реципиент</span>
              <span>🔒 +10 способностей</span>
            </div>
          </div>
        </div>
      </div>

      <div class="cta">
        <button class="btn" id="start">Узнать свой класс</button>
        <p class="fineprint">За диагнозом — к врачу. За поводом для гордости — сюда.</p>
      </div>
    </div>`;
  document.getElementById("start").onclick = () => { state.step = 0; render(); };
}

function renderQuestion(i, prem){
  const order = prem ? DB.premiumOrder : DB.order;
  const key = order[i];
  const m = DB.markers[key];
  const n = order.length;
  $app.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <button class="back" id="back">‹</button>
        <div class="progress-track"><div class="progress-fill" style="width:${(i/n)*100}%"></div></div>
        <div class="step-num">${prem ? "+" : ""}${i+1}/${n}</div>
      </div>
      <div class="q-emoji">${m.emoji}</div>
      <h2 class="q">${esc(m.q)}</h2>
      ${m.hint ? `<div class="q-hint">${esc(m.hint)}</div>` : ""}
      <div class="chips" id="chips">
        ${m.options.map(o => `
          <button class="chip${state.answers[key]===o.id ? " sel" : ""}" data-id="${esc(o.id)}">
            ${o.color ? `<span class="dot" style="background:${esc(o.color)}"></span>` : ""}
            ${esc(o.label)}
            ${o.skip ? '' : `<span class="freq">~${Math.round(o.freq*100)}%</span>`}
          </button>`).join("")}
      </div>
    </div>`;
  requestAnimationFrame(() => {
    const fill = document.querySelector(".progress-fill");
    if(fill) fill.style.width = ((i+1)/n)*100 + "%";
  });
  document.getElementById("back").onclick = () => {
    if(prem){
      if(i === 0){ state.premium = false; render(); } // назад из первого премиум-вопроса → базовый паспорт
      else { state.pstep = i-1; render(); }
    } else {
      state.step = i === 0 ? -1 : i-1; render();
    }
  };
  document.getElementById("chips").querySelectorAll(".chip").forEach(ch => {
    ch.onclick = () => {
      if(state._lock) return;
      state._lock = true;
      state.answers[key] = ch.dataset.id;
      if(tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
      ch.classList.add("sel");
      setTimeout(() => {
        state._lock = false;
        if(prem) state.pstep = i+1; else state.step = i+1;
        render();
      }, 260);
    };
  });
}

function renderIssuing(prem){
  const lines = prem ? [
    "> разблокировка реестра ........ <b>OK</b>",
    "> анализ премиум-маркеров ...... <b>OK</b>",
    "> пересчёт редкости ........... <b>OK</b>",
    "> допечать документа .......... <b>ГОТОВО</b>"
  ] : [
    "> проверка биомаркеров ......... <b>OK</b>",
    "> поиск в реестре носителей .... <b>OK</b>",
    "> расчёт редкости комбинации ... <b>OK</b>",
    "> печать документа ............. <b>ГОТОВО</b>"
  ];
  $app.innerHTML = `
    <div class="screen"><div class="issuing">
      <div class="label">${prem ? "Дополнение документа" : "Оформление документа"}</div>
      ${lines.map((l,i)=>`<div class="tline" style="animation-delay:${i*0.32}s">${l}</div>`).join("")}
    </div></div>`;
  setTimeout(() => { if(prem) state.pstep++; else state.step++; render(); }, lines.length*320 + 500);
}

function renderPassport(full){
  if(tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
  const r = buildResult(full);
  state.result = r;
  $app.innerHTML = `
    <div class="screen">
      <div class="passport-wrap">
        <div class="card" id="card">
          <div class="card-cover">
            <div class="l">
              <span class="dna">🧬</span>
              <div>
                <div class="t1">БИОПАСПОРТ</div>
                <div class="t2">BIOLOGICAL PASSPORT · RU</div>
              </div>
            </div>
            <div class="num">№ ${esc(r.num)}</div>
          </div>
          <div class="card-paper">
            <div class="f-row">
              <div style="flex:1">
                <div class="f-label">Предъявитель / Bearer</div>
                <div class="bearer">${esc(r.name)}</div>
              </div>
              <div>
                <div class="f-label">Выдан / Issued</div>
                <div class="bearer" style="font-size:14px">${esc(r.date)}</div>
              </div>
            </div>
            <div class="f-row">
              <div style="flex:1">
                <div class="f-label">Тип носителя / Carrier type</div>
                <div class="holder-type"><span>${esc(r.totem)}</span>${esc(r.typeName)}</div>
              </div>
            </div>
            <div class="f-row">
              <div>
                <div class="f-label">Редкость комбинации / Rarity</div>
                <div class="rarity">★ ${esc(r.tier).toUpperCase()}<small>такой набор — у 1 из ${esc(r.oneIn.toLocaleString("ru-RU"))} людей</small></div>
              </div>
            </div>
            <hr class="rule">
            <div class="f-label" style="margin-bottom:9px">Зарегистрированные способности / Abilities</div>
            <div class="abilities">
              ${r.powers.map((p,idx) => `
                <div class="ability${(OPEN_FIRST && idx===0) ? " open" : ""}" data-i="${idx}">
                  <button class="ability-head" type="button" aria-expanded="${OPEN_FIRST && idx===0 ? "true" : "false"}">
                    <span class="pe">${esc(p.emoji)}</span>
                    <span class="ability-name">${esc(p.name)}</span>
                    <span class="chev" aria-hidden="true">›</span>
                  </button>
                  <div class="ability-body"><div class="inner"><p class="power-sup">${esc(descOf(p))}</p>${p.risk ? `<p class="power-risk">${esc(p.risk)}</p>` : ""}</div></div>
                </div>`).join("")}
            </div>
            ${full ? "" : `<div class="locked">🔒 Ещё ${DB.premiumOrder.length} биомаркеров и PDF — в полном паспорте</div>`}
            <div class="stamp">ВЫДАНО<br>BIOPASSPORT·26</div>
            <div class="mrz">${esc(r.mrz1)}<br>${esc(r.mrz2)}</div>
          </div>
        </div>
      </div>
      <div class="actions">
        <button class="btn" id="share">Поделиться в историю</button>
        <button class="btn ghost" id="save">Сохранить как фото</button>
        ${full
          ? `<button class="btn ghost" id="pdf">📄 Сохранить в PDF</button>`
          : `<button class="btn ghost" id="full">🔓 Полный паспорт — ⭐ ${PRICE_STARS}</button>`}
      </div>
      <div class="again"><button id="again">Оформить заново</button></div>
    </div>`;
  document.getElementById("share").onclick = shareStory;
  document.getElementById("save").onclick = savePNG;
  if(full) document.getElementById("pdf").onclick = savePDF;
  else document.getElementById("full").onclick = showPaywall;
  document.getElementById("again").onclick = () => {
    state.step = -1; state.answers = {}; state.premium = false; state.pstep = 0; state.result = null; render();
  };
  $app.querySelectorAll(".ability-head").forEach(h => {
    h.onclick = () => {
      const ab = h.closest(".ability");
      const open = ab.classList.toggle("open");
      h.setAttribute("aria-expanded", open ? "true" : "false");
    };
  });
}

/* ===================== ДЕЙСТВИЯ ===================== */
// PNG-карточка → base64 (без префикса data:) → бэкенд → публичный URL картинки
function blobToBase64(blob){
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
async function uploadCanvas(canvas){
  const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
  if(!blob) throw new Error("empty image");
  const b64 = await blobToBase64(blob);
  const res = await fetch(BACKEND_URL + "?action=upload", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: b64 })
  });
  const j = await res.json();
  if(!j.url) throw new Error(j.error || "upload failed");
  return j.url;
}

// Отдельный вертикальный плакат 1080×1920 под Историю (карточка паспорта слишком высокая
// и обрезается по центру). Акцент — тип носителя и редкость «1 из N».
async function renderStoryCanvas(){
  const r = state.result;
  const handle = "@" + DB.botUrl.split("/").filter(Boolean).pop();
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;left:-99999px;top:0;z-index:-1";
  wrap.innerHTML = `
    <div style="width:1080px;height:1920px;box-sizing:border-box;padding:130px 96px 110px;
      background:radial-gradient(125% 80% at 50% 0%, #16291F 0%, #0B1411 58%);
      color:#EAF3EE;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
      display:flex;flex-direction:column;align-items:center;text-align:center">
      <div style="font-size:128px;line-height:1">🧬</div>
      <div style="margin-top:26px;font-size:66px;font-weight:800;letter-spacing:7px;color:#E7C66B">БИОПАСПОРТ</div>
      <div style="margin-top:12px;font-size:26px;letter-spacing:9px;color:#7E8C84">BIOLOGICAL PASSPORT</div>

      <div style="margin-top:120px;font-size:30px;letter-spacing:5px;color:#7E8C84">ТИП НОСИТЕЛЯ</div>
      <div style="margin-top:18px;font-size:66px;font-weight:700;line-height:1.12">${esc(r.totem)} ${esc(r.typeName)}</div>
      <div style="margin-top:16px;font-size:38px;color:#B9C6BE">${esc(r.name)}</div>

      <div style="margin-top:130px;font-size:30px;letter-spacing:4px;color:#7E8C84">РЕДКОСТЬ КОМБИНАЦИИ</div>
      <div style="margin-top:22px;font-size:158px;font-weight:800;color:#E7C66B;line-height:1">1 из ${esc(r.oneIn.toLocaleString("ru-RU"))}</div>
      <div style="margin-top:14px;font-size:42px;color:#EAF3EE">★ ${esc(r.tier)}</div>

      <div style="flex:1"></div>
      <div style="font-size:42px;font-weight:700">Проверь свой биотип →</div>
      <div style="margin-top:20px;font-size:36px;color:#E7C66B">${esc(handle)}</div>
    </div>`;
  document.body.appendChild(wrap);
  try{
    return await html2canvas(wrap.firstElementChild, { scale: 1, backgroundColor: null, useCORS: true, logging: false });
  } finally { wrap.remove(); }
}

// «Поделиться» → публикация вертикального плаката в Историю Telegram (нужен бэкенд + shareToStory)
async function shareStory(){
  if(!(BACKEND_URL && tg && tg.shareToStory)) return share(); // фоллбэк: обычный шэринг ссылкой
  const r = state.result;
  toast("Готовлю историю…");
  try{
    const canvas = await renderStoryCanvas();
    const url = await uploadCanvas(canvas);
    tg.shareToStory(url, { text: `Мой биотип: «${r.typeName}» ${r.totem} · редкость 1 из ${r.oneIn.toLocaleString("ru-RU")}` });
  }catch(e){ toast("Не вышло опубликовать историю — попробуй «Сохранить как фото»"); }
}

function share(){
  const r = state.result;
  const text = `🧬 Мой биотип: «${r.typeName}» ${r.totem}\nРедкость: ${r.tier.toLowerCase()} — 1 из ${r.oneIn.toLocaleString("ru-RU")}.\nПроверь свои суперспособности:`;
  const url = DB.botUrl;
  if(tg && tg.openTelegramLink){
    tg.openTelegramLink("https://t.me/share/url?url=" + encodeURIComponent(url) + "&text=" + encodeURIComponent(text));
    return;
  }
  if(navigator.share){ navigator.share({text: text + "\n" + url}).catch(()=>{}); return; }
  if(navigator.clipboard){ navigator.clipboard.writeText(text + "\n" + url).then(()=>toast("Текст скопирован — вставь в чат")); return; }
  toast("Шаринг доступен внутри Telegram");
}

// В клоне: отключаем анимации и принудительно раскрываем все способности —
// сохранённый/печатаемый паспорт должен быть полным независимо от того, что открыто в UI.
function passportOnclone(doc){
  const st = doc.createElement("style");
  st.textContent =
    "*{animation:none!important;transition:none!important}" +
    ".card{box-shadow:none!important}" +
    ".stamp{opacity:.72!important;transform:rotate(-12deg) scale(1)!important}" +
    ".ability-body{grid-template-rows:1fr!important}" +
    ".chev{transform:rotate(90deg)!important}";
  doc.head.appendChild(st);
}

async function renderCardCanvas(){
  const node = document.getElementById("card");
  return html2canvas(node, { scale: 2, backgroundColor: null, useCORS: true, logging: false, onclone: passportOnclone });
}

async function savePNG(){
  if(typeof html2canvas === "undefined"){ toast("html2canvas не загрузился (проверь интернет/CDN)"); return; }
  toast("Готовлю изображение…");

  let canvas;
  try{ canvas = await renderCardCanvas(); }
  catch(e){ toast("Не вышло отрисовать карточку — сделай скриншот"); return; }

  const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
  if(!blob){ toast("Пустое изображение — сделай скриншот"); return; }
  const file = new File([blob], "biopassport.png", { type: "image/png" });

  // 0) Telegram + бэкенд: надёжное сохранение через downloadFile (особенно Android, где <a download> не работает)
  if(BACKEND_URL && tg && tg.downloadFile){
    try{
      const b64 = await blobToBase64(blob);
      const res = await fetch(BACKEND_URL + "?action=upload", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: b64 })
      });
      const j = await res.json();
      if(j.url){ tg.downloadFile({ url: j.url, file_name: "biopassport.png" }); return; }
    }catch(e){ /* падаем на старые способы ниже */ }
  }

  // 1) Нативный шэринг файла — лучший путь в Telegram и на мобильных
  if(navigator.canShare && navigator.canShare({ files: [file] })){
    try{ await navigator.share({ files: [file], title: "Биопаспорт" }); return; }
    catch(e){ if(e && e.name === "AbortError") return; }
  }
  // 2) Прямое скачивание — работает на десктопе
  try{
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "biopassport.png";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast("Паспорт сохранён 📄");
    return;
  }catch(e){}
  // 3) Последний фоллбэк — открыть картинку, долгий тап → «Сохранить»
  try{
    window.open(URL.createObjectURL(blob), "_blank");
    toast("Долгий тап по картинке → «Сохранить»");
  }catch(e){ toast("Не удалось сохранить — сделай скриншот"); }
}

async function savePDF(){
  if(typeof html2canvas === "undefined"){ toast("html2canvas не загрузился (проверь интернет/CDN)"); return; }
  const jsPDFlib = window.jspdf && window.jspdf.jsPDF;
  if(!jsPDFlib){ toast("PDF-библиотека не загрузилась (проверь интернет/CDN)"); return; }
  toast("Готовлю PDF…");

  const card = document.getElementById("card");

  // Раскрываем все способности в живом DOM (без анимации) — чтобы измерения границ
  // совпадали с тем, что отрисует html2canvas (он тоже раскрывает всё в клоне).
  const noAnim = document.createElement("style");
  noAnim.textContent = ".card *{transition:none!important;animation:none!important}";
  document.head.appendChild(noAnim);
  const abilities = Array.prototype.slice.call(card.querySelectorAll(".ability"));
  const wasOpen = abilities.map(a => a.classList.contains("open"));
  abilities.forEach(a => a.classList.add("open"));
  void card.offsetHeight; // форсируем рефлоу

  let canvas, breaks;
  try{
    // Безопасные точки переноса (CSS-px от верха карточки): начало каждого блока
    const cardTop = card.getBoundingClientRect().top;
    breaks = [0];
    card.querySelectorAll(".ability, .rule, .locked, .mrz, .stamp").forEach(el => {
      breaks.push(el.getBoundingClientRect().top - cardTop);
    });
    breaks.push(card.offsetHeight);
    breaks = breaks.filter((v,i,arr) => v >= 0 && arr.indexOf(v) === i).sort((a,b) => a-b);
    const cssH = card.offsetHeight, cssW = card.offsetWidth;
    canvas = await renderCardCanvas();
    var ratio = canvas.height / cssH; // canvas-px на 1 CSS-px
    var cssWidth = cssW;
  }catch(e){
    abilities.forEach((a,i) => { if(!wasOpen[i]) a.classList.remove("open"); });
    noAnim.remove();
    toast("Не вышло отрисовать карточку — сделай скриншот"); return;
  }

  // Восстанавливаем исходное состояние аккордеона
  abilities.forEach((a,i) => { if(!wasOpen[i]) a.classList.remove("open"); });
  noAnim.remove();

  try{
    const pdf = new jsPDFlib({ orientation: "portrait", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    // Сколько CSS-px карточки влезает на одну A4-страницу при вписывании по ширине
    const cssPerPage = cssWidth * (pageH / pageW);
    const totalCss = canvas.height / ratio;

    let startCss = 0, first = true;
    while(startCss < totalCss - 1){
      const limit = startCss + cssPerPage;
      // ищем самую нижнюю безопасную границу, влезающую на страницу
      let cut = -1;
      for(const b of breaks){ if(b > startCss + 4 && b <= limit + 0.5) cut = b; }
      if(cut < 0) cut = Math.min(limit, totalCss); // ни одна граница не влезла → жёсткий рез
      cut = Math.min(cut, totalCss);

      const sy = Math.round(startCss * ratio);
      const sh = Math.max(1, Math.round((cut - startCss) * ratio));
      const slice = document.createElement("canvas");
      slice.width = canvas.width; slice.height = sh;
      slice.getContext("2d").drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);

      const imgHmm = pageW * sh / canvas.width;
      if(!first) pdf.addPage();
      pdf.addImage(slice.toDataURL("image/png"), "PNG", 0, 0, pageW, imgHmm);
      first = false;
      startCss = cut;
    }

    pdf.save("biopassport.pdf"); // десктоп — скачивание; в Telegram webview потребует бэкенд (downloadFile)
    toast("PDF сохранён 📄");
  }catch(e){ toast("Не удалось собрать PDF — сделай скриншот"); }
}

function showPaywall(){
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `
    <div class="sheet">
      <div class="label">Полный биопаспорт</div>
      <h3>Ещё ${DB.premiumOrder.length} биомаркеров</h3>
      <p>Хронотип, переносимость лактозы, вкусовая чувствительность и другие редкие генетические маркеры. Все способности в одной карточке + сохранение в PDF.</p>
      <div class="price">⭐ ${PRICE_STARS} · Telegram Stars</div>
      <button class="btn" id="pay">Оплатить ⭐ ${PRICE_STARS}</button>
      <button class="btn ghost" id="close-pay">Позже</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector("#pay").onclick = async () => {
    // Реальная оплата Telegram Stars: бэкенд отдаёт invoice-ссылку → tg.openInvoice
    if(BACKEND_URL && tg && tg.openInvoice){
      toast("Открываю оплату…");
      try{
        const res = await fetch(BACKEND_URL + "?action=invoice", {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}"
        });
        const j = await res.json();
        if(!j.link) throw new Error(j.error || "no link");
        ov.remove();
        tg.openInvoice(j.link, (status) => {
          if(status === "paid"){ toast("Оплата прошла ✅"); state.premium = true; state.pstep = 0; render(); }
          else if(status === "failed") toast("Оплата не прошла");
        });
        return;
      }catch(e){ toast("Не удалось открыть оплату"); return; }
    }
    // Фоллбэк (нет бэкенда / не в Telegram): заглушка, чтобы протестировать премиум-флоу
    ov.remove();
    toast("Тестовый режим: оплата-заглушка");
    state.premium = true;
    state.pstep = 0;
    render();
  };
  ov.querySelector("#close-pay").onclick = () => ov.remove();
  ov.onclick = e => { if(e.target === ov) ov.remove(); };
}

render();
