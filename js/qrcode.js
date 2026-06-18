"use strict";

/* =====================================================================
   Минимальный генератор QR-кодов — байтовый режим, уровень коррекции M,
   версии 1–10 (до ~270 байт). Полностью офлайн, без внешних сервисов:
   QR рисуется прямо в canvas, чтобы экспорт истории не зависел от сети.
   Алгоритм адаптирован из QR Code generator library (Project Nayuki, MIT).
   Публичное API: QR.toDataURL(text [,scale,margin,dark,light]) → data:image/png
   ===================================================================== */
var QR = (function(){
  // Таблицы для уровня коррекции M, индекс = version-1 (версии 1..10).
  const ECC_PER_BLOCK = [10,16,26,18,24,16,18,22,22,26];
  const NUM_BLOCKS    = [ 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const MAX_VERSION   = 10;

  function getBit(x,i){ return ((x >>> i) & 1) !== 0; }

  function toUtf8Bytes(str){
    const out = [], s = encodeURIComponent(str);
    for(let i=0;i<s.length;i++){
      if(s[i] === "%"){ out.push(parseInt(s.substr(i+1,2),16)); i+=2; }
      else out.push(s.charCodeAt(i));
    }
    return out;
  }

  function getNumRawDataModules(ver){
    let result = (16*ver + 128)*ver + 64;
    if(ver >= 2){
      const numAlign = Math.floor(ver/7) + 2;
      result -= (25*numAlign - 10)*numAlign - 55;
      if(ver >= 7) result -= 36;
    }
    return result;
  }
  function getNumDataCodewords(ver){
    return Math.floor(getNumRawDataModules(ver)/8) - ECC_PER_BLOCK[ver-1]*NUM_BLOCKS[ver-1];
  }
  function getAlignmentPatternPositions(ver, size){
    if(ver === 1) return [];
    const numAlign = Math.floor(ver/7) + 2;
    const step = Math.ceil((ver*4 + 4)/(numAlign*2 - 2))*2;
    const result = [6];
    for(let pos = size-7; result.length < numAlign; pos -= step) result.splice(1,0,pos);
    return result;
  }

  /* ---------- Reed–Solomon (GF(256), полином 0x11D) ---------- */
  function rsMultiply(x,y){
    let z = 0;
    for(let i=7;i>=0;i--){
      z = (z<<1) ^ ((z>>>7)*0x11D);
      z ^= ((y>>>i)&1)*x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree){
    const result = new Array(degree).fill(0);
    result[degree-1] = 1;
    let root = 1;
    for(let i=0;i<degree;i++){
      for(let j=0;j<result.length;j++){
        result[j] = rsMultiply(result[j], root);
        if(j+1 < result.length) result[j] ^= result[j+1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor){
    const result = divisor.map(() => 0);
    for(const b of data){
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef,i) => result[i] ^= rsMultiply(coef, factor));
    }
    return result;
  }

  function appendBits(val, len, bb){ for(let i=len-1;i>=0;i--) bb.push((val>>>i)&1); }

  function addEccAndInterleave(data, version){
    const numBlocks = NUM_BLOCKS[version-1];
    const blockEccLen = ECC_PER_BLOCK[version-1];
    const rawCodewords = Math.floor(getNumRawDataModules(version)/8);
    const numShort = numBlocks - rawCodewords % numBlocks;
    const shortLen = Math.floor(rawCodewords / numBlocks);
    const div = rsDivisor(blockEccLen);
    const blocks = [];
    for(let i=0, k=0; i<numBlocks; i++){
      const datLen = shortLen - blockEccLen + (i < numShort ? 0 : 1);
      const dat = data.slice(k, k+datLen);
      k += datLen;
      blocks.push({ dat, ecc: rsRemainder(dat, div) });
    }
    const result = [];
    for(let i=0; i <= shortLen - blockEccLen; i++){
      for(let j=0; j<numBlocks; j++){
        if(i < shortLen - blockEccLen || j >= numShort) result.push(blocks[j].dat[i]);
      }
    }
    for(let i=0; i<blockEccLen; i++){
      for(let j=0; j<numBlocks; j++) result.push(blocks[j].ecc[i]);
    }
    return result;
  }

  function encode(text){
    const data = toUtf8Bytes(text);
    let version = 1;
    for(; version <= MAX_VERSION; version++){
      const ccBits = version < 10 ? 8 : 16;
      if(4 + ccBits + data.length*8 <= getNumDataCodewords(version)*8) break;
    }
    if(version > MAX_VERSION) throw new Error("QR: data too long");

    const bb = [];
    appendBits(0x4, 4, bb);                       // байтовый режим
    appendBits(data.length, version < 10 ? 8 : 16, bb);
    for(const b of data) appendBits(b, 8, bb);
    const capBits = getNumDataCodewords(version)*8;
    appendBits(0, Math.min(4, capBits - bb.length), bb); // терминатор
    appendBits(0, (8 - bb.length % 8) % 8, bb);          // до границы байта
    for(let pad = 0xEC; bb.length < capBits; pad ^= 0xEC ^ 0x11) appendBits(pad, 8, bb);

    const codewords = [];
    for(let i=0;i<bb.length;i+=8){
      let b = 0; for(let j=0;j<8;j++) b = (b<<1) | bb[i+j];
      codewords.push(b);
    }
    return build(version, addEccAndInterleave(codewords, version));
  }

  function build(version, codewords){
    const size = version*4 + 17;
    const modules = [], isFn = [];
    for(let i=0;i<size;i++){ modules.push(new Array(size).fill(false)); isFn.push(new Array(size).fill(false)); }

    function set(x,y,dark){ modules[y][x] = dark; isFn[y][x] = true; }

    function finder(x,y){
      for(let dy=-4;dy<=4;dy++) for(let dx=-4;dx<=4;dx++){
        const xx = x+dx, yy = y+dy, dist = Math.max(Math.abs(dx),Math.abs(dy));
        if(xx>=0 && xx<size && yy>=0 && yy<size) set(xx,yy, dist!==2 && dist!==4);
      }
    }
    function alignment(x,y){
      for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++)
        set(x+dx, y+dy, Math.max(Math.abs(dx),Math.abs(dy)) !== 1);
    }
    function drawFormat(mask){
      const dataBits = (0 << 3) | mask; // уровень M → 0
      let rem = dataBits;
      for(let i=0;i<10;i++) rem = (rem<<1) ^ ((rem>>>9)*0x537);
      const bits = ((dataBits<<10) | rem) ^ 0x5412;
      for(let i=0;i<=5;i++) set(8,i, getBit(bits,i));
      set(8,7, getBit(bits,6)); set(8,8, getBit(bits,7)); set(7,8, getBit(bits,8));
      for(let i=9;i<15;i++) set(14-i,8, getBit(bits,i));
      for(let i=0;i<8;i++) set(size-1-i,8, getBit(bits,i));
      for(let i=8;i<15;i++) set(8, size-15+i, getBit(bits,i));
      set(8, size-8, true);
    }
    function drawVersion(){
      if(version < 7) return;
      let rem = version;
      for(let i=0;i<12;i++) rem = (rem<<1) ^ ((rem>>>11)*0x1F25);
      const bits = (version<<12) | rem;
      for(let i=0;i<18;i++){
        const bit = getBit(bits,i), a = size-11 + i%3, b = Math.floor(i/3);
        set(a,b,bit); set(b,a,bit);
      }
    }

    // функциональные узоры
    for(let i=0;i<size;i++){ set(6,i, i%2===0); set(i,6, i%2===0); }
    finder(3,3); finder(size-4,3); finder(3,size-4);
    const ap = getAlignmentPatternPositions(version, size), na = ap.length;
    for(let i=0;i<na;i++) for(let j=0;j<na;j++){
      if(!((i===0&&j===0) || (i===0&&j===na-1) || (i===na-1&&j===0))) alignment(ap[i], ap[j]);
    }
    drawFormat(0);
    drawVersion();

    // данные
    let bi = 0;
    for(let right = size-1; right >= 1; right -= 2){
      if(right === 6) right = 5;
      for(let vert=0;vert<size;vert++){
        for(let j=0;j<2;j++){
          const x = right - j, upward = ((right+1) & 2) === 0;
          const y = upward ? size-1-vert : vert;
          if(!isFn[y][x] && bi < codewords.length*8){
            modules[y][x] = getBit(codewords[bi >>> 3], 7 - (bi & 7));
            bi++;
          }
        }
      }
    }

    function applyMask(mask){
      for(let y=0;y<size;y++) for(let x=0;x<size;x++){
        let invert = false;
        switch(mask){
          case 0: invert = (x+y)%2 === 0; break;
          case 1: invert = y%2 === 0; break;
          case 2: invert = x%3 === 0; break;
          case 3: invert = (x+y)%3 === 0; break;
          case 4: invert = (Math.floor(x/3)+Math.floor(y/2))%2 === 0; break;
          case 5: invert = (x*y)%2 + (x*y)%3 === 0; break;
          case 6: invert = ((x*y)%2 + (x*y)%3)%2 === 0; break;
          case 7: invert = ((x+y)%2 + (x*y)%3)%2 === 0; break;
        }
        if(!isFn[y][x] && invert) modules[y][x] = !modules[y][x];
      }
    }

    function addHist(run, h){ if(h[0]===0) run += size; h.copyWithin(1,0); h[0] = run; }
    function countPatterns(h){
      const n = h[1];
      const core = n>0 && h[2]===n && h[3]===n*3 && h[4]===n && h[5]===n;
      return (core && h[0] >= n*4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n*4 && h[0] >= n ? 1 : 0);
    }
    function terminate(color, run, h){
      if(color){ addHist(run, h); run = 0; }
      run += size; addHist(run, h);
      return countPatterns(h);
    }
    function penalty(){
      let result = 0;
      for(let y=0;y<size;y++){
        let color=false, run=0; const h=[0,0,0,0,0,0,0];
        for(let x=0;x<size;x++){
          if(modules[y][x]===color){ run++; if(run===5) result+=3; else if(run>5) result++; }
          else { addHist(run,h); if(!color) result += countPatterns(h)*40; color=modules[y][x]; run=1; }
        }
        result += terminate(color, run, h)*40;
      }
      for(let x=0;x<size;x++){
        let color=false, run=0; const h=[0,0,0,0,0,0,0];
        for(let y=0;y<size;y++){
          if(modules[y][x]===color){ run++; if(run===5) result+=3; else if(run>5) result++; }
          else { addHist(run,h); if(!color) result += countPatterns(h)*40; color=modules[y][x]; run=1; }
        }
        result += terminate(color, run, h)*40;
      }
      for(let y=0;y<size-1;y++) for(let x=0;x<size-1;x++){
        const c = modules[y][x];
        if(c===modules[y][x+1] && c===modules[y+1][x] && c===modules[y+1][x+1]) result += 3;
      }
      let dark=0; for(let y=0;y<size;y++) for(let x=0;x<size;x++) if(modules[y][x]) dark++;
      const total = size*size;
      const k = Math.ceil(Math.abs(dark*20 - total*10)/total) - 1;
      result += k*10;
      return result;
    }

    let bestMask = 0, minPenalty = Infinity;
    for(let m=0;m<8;m++){
      applyMask(m); drawFormat(m);
      const p = penalty();
      if(p < minPenalty){ minPenalty = p; bestMask = m; }
      applyMask(m); // откат (XOR — обратим)
    }
    applyMask(bestMask); drawFormat(bestMask);
    return { size, modules };
  }

  return {
    generate: encode,
    toDataURL: function(text, scale, margin, dark, light){
      const qr = encode(text);
      scale = scale || 4; margin = (margin == null) ? 4 : margin;
      dark = dark || "#000000"; light = light || "#ffffff";
      const dim = (qr.size + margin*2)*scale;
      const c = document.createElement("canvas");
      c.width = c.height = dim;
      const ctx = c.getContext("2d");
      ctx.fillStyle = light; ctx.fillRect(0,0,dim,dim);
      ctx.fillStyle = dark;
      for(let y=0;y<qr.size;y++) for(let x=0;x<qr.size;x++)
        if(qr.modules[y][x]) ctx.fillRect((x+margin)*scale, (y+margin)*scale, scale, scale);
      return c.toDataURL("image/png");
    }
  };
})();
