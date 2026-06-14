"use strict";

/* ===================== КОНСТАНТЫ ===================== */
const OPEN_FIRST = true; // первая способность раскрыта по умолчанию
const STRESS = /[?&#]stress/i.test(location.search + location.hash); // ?stress — длинные тексты для теста вёрстки
const LONG_DEMO = "Расширенное демо-описание для стресс-теста вёрстки. Меланин радужной оболочки работает как встроенный светофильтр: он рассеивает часть коротковолнового излучения и снижает блики в яркий полдень. У носителей этого маркера обычно выше контрастная чувствительность на солнце, но ниже — в сумерках. Этот абзац намеренно длинный, чтобы проверить переносы строк, межстрочный интервал и корректность экспорта карточки в PNG при большом объёме контента.";
function descOf(p){ return STRESS ? (p.desc + " " + LONG_DEMO) : p.desc; }

/* ===================== СОСТОЯНИЕ ===================== */
const state = { step:-1, answers:{} }; // step: -1 welcome, 0..N вопросы, N "issuing", N+1 паспорт
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
function buildResult(){
  const a = state.answers;
  const picked = DB.order.map(k => DB.markers[k].options.find(o => o.id === a[k]));
  const powers = DB.order.map((k,i) => picked[i].power ? { emoji: DB.markers[k].emoji, ...picked[i].power } : null).filter(Boolean);
  const p = picked.reduce((acc,o) => acc * o.freq, 1);
  const oneIn = Math.max(2, Math.round(1/p));
  const tier = DB.rarityTiers.find(t => oneIn <= t.max).name;
  const typeName = (DB.typeAdj[a.eyes] || "Базовый") + " " + (DB.typeNoun[a.blood] || "Носитель");
  const totem = DB.totem[a.body] || "🧬";
  const name = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.first_name)
    ? tg.initDataUnsafe.user.first_name.toUpperCase() : "ПРЕДЪЯВИТЕЛЬ";
  const num = "BIO-" + String(1000000 + Date.now() % 9000000).slice(0,7);
  const d = new Date();
  const date = [String(d.getDate()).padStart(2,"0"), String(d.getMonth()+1).padStart(2,"0"), d.getFullYear()].join(".");
  const mrz1 = mrzPad("P<BIO<" + translit(typeName) + "<<" + translit(name), 30);
  const mrz2 = mrzPad(num.replace("-","") + "<" + date.replace(/\./g,"") + "<1IN" + oneIn, 30);
  return { name, num, date, typeName, totem, tier, oneIn, powers, mrz1, mrz2 };
}

/* ===================== ЭКРАНЫ ===================== */
function render(){
  const n = DB.order.length;
  if(state.step === -1) return renderWelcome();
  if(state.step < n)    return renderQuestion(state.step);
  if(state.step === n)  return renderIssuing();
  renderPassport();
}

function renderWelcome(){
  $app.innerHTML = `
    <div class="screen">
      <div class="hero">
        <div class="emblem">🧬</div>
        <h1 class="title">БИОПАСПОРТ</h1>
        <div class="title-sub">BIOLOGICAL PASSPORT</div>
        <p class="lede">Документ о врождённых суперспособностях твоего организма. 6 вопросов, 60 секунд, без регистрации.</p>
        <p class="fineprint">Не является медицинским документом. Но выглядит солиднее 🙂</p>
      </div>
      <button class="btn" id="start">Оформить паспорт</button>
    </div>`;
  document.getElementById("start").onclick = () => { state.step = 0; render(); };
}

function renderQuestion(i){
  const key = DB.order[i];
  const m = DB.markers[key];
  const n = DB.order.length;
  $app.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <button class="back" id="back">‹</button>
        <div class="progress-track"><div class="progress-fill" style="width:${(i/n)*100}%"></div></div>
        <div class="step-num">${i+1}/${n}</div>
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
  document.getElementById("back").onclick = () => { state.step = i === 0 ? -1 : i-1; render(); };
  document.getElementById("chips").querySelectorAll(".chip").forEach(ch => {
    ch.onclick = () => {
      if(state._lock) return;
      state._lock = true;
      state.answers[key] = ch.dataset.id;
      if(tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
      ch.classList.add("sel");
      setTimeout(() => { state._lock = false; state.step = i+1; render(); }, 260);
    };
  });
}

function renderIssuing(){
  const lines = [
    "> проверка биомаркеров ......... <b>OK</b>",
    "> поиск в реестре носителей .... <b>OK</b>",
    "> расчёт редкости комбинации ... <b>OK</b>",
    "> печать документа ............. <b>ГОТОВО</b>"
  ];
  $app.innerHTML = `
    <div class="screen"><div class="issuing">
      <div class="label">Оформление документа</div>
      ${lines.map((l,i)=>`<div class="tline" style="animation-delay:${i*0.32}s">${l}</div>`).join("")}
    </div></div>`;
  setTimeout(() => { state.step++; render(); }, lines.length*320 + 500);
}

function renderPassport(){
  if(tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
  const r = buildResult();
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
            <div class="locked">🔒 Ещё 4 способности, премиум-дизайн и PDF — в полном паспорте</div>
            <div class="stamp">ВЫДАНО<br>BIOPASSPORT·26</div>
            <div class="mrz">${esc(r.mrz1)}<br>${esc(r.mrz2)}</div>
          </div>
        </div>
      </div>
      <div class="actions">
        <button class="btn" id="share">Поделиться в Telegram</button>
        <button class="btn ghost" id="save">Сохранить как фото</button>
        <button class="btn ghost" id="full">🔓 Полный паспорт — 149 ₽</button>
      </div>
      <div class="again"><button id="again">Оформить заново</button></div>
    </div>`;
  document.getElementById("share").onclick = share;
  document.getElementById("save").onclick = savePNG;
  document.getElementById("full").onclick = showPaywall;
  document.getElementById("again").onclick = () => { state.step = -1; state.answers = {}; render(); };
  $app.querySelectorAll(".ability-head").forEach(h => {
    h.onclick = () => {
      const ab = h.closest(".ability");
      const open = ab.classList.toggle("open");
      h.setAttribute("aria-expanded", open ? "true" : "false");
    };
  });
}

/* ===================== ДЕЙСТВИЯ ===================== */
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

async function savePNG(){
  if(typeof html2canvas === "undefined"){ toast("html2canvas не загрузился (проверь интернет/CDN)"); return; }
  const node = document.getElementById("card");
  toast("Готовлю изображение…");

  let canvas;
  try{
    canvas = await html2canvas(node, {
      scale: 2,
      backgroundColor: null,
      useCORS: true,
      logging: false,
      onclone: (doc) => {
        // В клоне: отключаем анимации и принудительно раскрываем все способности —
        // сохранённый паспорт должен быть полным независимо от того, что открыто в UI.
        const st = doc.createElement("style");
        st.textContent =
          "*{animation:none!important;transition:none!important}" +
          ".card{box-shadow:none!important}" +
          ".stamp{opacity:.72!important;transform:rotate(-12deg) scale(1)!important}" +
          ".ability-body{grid-template-rows:1fr!important}" +
          ".chev{transform:rotate(90deg)!important}";
        doc.head.appendChild(st);
      }
    });
  }catch(e){ toast("Не вышло отрисовать карточку — сделай скриншот"); return; }

  const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
  if(!blob){ toast("Пустое изображение — сделай скриншот"); return; }
  const file = new File([blob], "biopassport.png", { type: "image/png" });

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

function showPaywall(){
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `
    <div class="sheet">
      <div class="label">Полный биопаспорт</div>
      <h3>Все 10 маркеров и 10 способностей</h3>
      <p>Хронотип, фототип кожи, вкусовая чувствительность и редкие генетические комбинации. Премиум-дизайн карточки + PDF на стену.</p>
      <div class="price">149 ₽ · Telegram Stars / ЮKassa</div>
      <button class="btn" id="pay">Оплатить</button>
      <button class="btn ghost" id="close-pay">Позже</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector("#pay").onclick = () => {
    // TODO: подключить Telegram Stars (sendInvoice) — реализуется в v0.3 с бекендом
    toast("Оплата будет доступна в следующей версии");
    ov.remove();
  };
  ov.querySelector("#close-pay").onclick = () => ov.remove();
  ov.onclick = e => { if(e.target === ov) ov.remove(); };
}

render();
