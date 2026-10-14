/* SimClin — utilidades compartidas por monitor, control y facilitador */
(function () {
  // Conexión en vivo con el servidor (Server-Sent Events). Reintenta sola si se cae el wifi.
  function conectar(rol, cid, alRecibir, alCambiarConexion) {
    let fuente = null;
    let reintento = null;
    function abrir() {
      const q = new URLSearchParams({ rol });
      if (cid) q.set("cid", cid);
      fuente = new EventSource("/eventos?" + q.toString());
      fuente.onopen = () => alCambiarConexion && alCambiarConexion(true);
      fuente.onmessage = (e) => {
        try { alRecibir(JSON.parse(e.data)); } catch (err) { console.error(err); }
      };
      fuente.onerror = () => {
        alCambiarConexion && alCambiarConexion(false);
        fuente.close();
        clearTimeout(reintento);
        reintento = setTimeout(abrir, 1500);
      };
    }
    abrir();
  }

  async function enviar(ruta, cuerpo) {
    const r = await fetch(ruta, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo || {}),
    });
    return r.json().catch(() => ({}));
  }

  function idDispositivo() {
    const k = "simclin_cid";
    let v = null;
    try { v = localStorage.getItem(k); } catch (e) {}
    if (!v) {
      v = "c" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem(k, v); } catch (e) {}
    }
    return v;
  }

  function reloj(seg) {
    seg = Math.max(0, Math.floor(seg || 0));
    const m = Math.floor(seg / 60), s = seg % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  // Íconos de línea (mismo estilo del diseño de Figma Make)
  const ICONOS = {
    cabeza: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0-6 6c0 2.2 1 3.6 2 4.6V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-3.4c1-1 2-2.4 2-4.6a6 6 0 0 0-6-6z"/><circle cx="9.8" cy="10" r=".9"/><circle cx="14.2" cy="10" r=".9"/><path d="M10 14.5h4"/></svg>',
    pulmones: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v8"/><path d="M12 11c-1 1-2 1-3 0"/><path d="M12 11c1 1 2 1 3 0"/><path d="M8.5 8.5C6 9 4 13 4 17c0 1.7 1 2.5 2.4 2.2L9 18.6c.6-.2 1-.7 1-1.4V11"/><path d="M15.5 8.5C18 9 20 13 20 17c0 1.7-1 2.5-2.4 2.2L15 18.6c-.6-.2-1-.7-1-1.4V11"/></svg>',
    corazon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M8 11h2l1-2 2 4 1-2h2"/></svg>',
    abdomen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4c-1 3-1 5 0 8-1 3-1 5 1 8h8c2-3 2-5 1-8 1-3 1-5 0-8"/><circle cx="12" cy="12" r=".8"/></svg>',
    mano: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21v-4l-3-4c-.6-.8-.4-1.9.4-2.4.7-.4 1.6-.2 2.1.4L10 13V5a1.3 1.3 0 0 1 2.6 0v5"/><path d="M12.6 10V4.5a1.3 1.3 0 0 1 2.6 0V10"/><path d="M15.2 10V6a1.3 1.3 0 0 1 2.6 0v7c0 3-1.5 5-3.8 6.2V21"/></svg>',
    cerebro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 4 3 3 0 0 0 5 1V6a2.5 2.5 0 0 0-2-1z"/><path d="M15 5a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 4 3 3 0 0 1-5 1V6a2.5 2.5 0 0 1 2-1z"/></svg>',
    estetoscopio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v5a4 4 0 0 0 8 0V3"/><path d="M10 12v2a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="10" r="2"/></svg>',
    general: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.5"/><path d="M8 21v-6l-2-1V9.5A1.5 1.5 0 0 1 7.5 8h9A1.5 1.5 0 0 1 18 9.5V14l-2 1v6"/></svg>',
  };

  function mezclarColor(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ra = pa >> 16, ga = (pa >> 8) & 255, ba = pa & 255;
    const rb = pb >> 16, gb = (pb >> 8) & 255, bb = pb & 255;
    const r = Math.round(ra + (rb - ra) * t), g = Math.round(ga + (gb - ga) * t), bl = Math.round(ba + (bb - ba) * t);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  function escapar(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function qrSVG(texto, tam) {
    if (typeof qrcode !== "function") return "";
    const q = qrcode(0, "M");
    q.addData(texto);
    q.make();
    return q.createSvgTag({ cellSize: Math.max(2, Math.floor((tam || 180) / (q.getModuleCount() + 8))), margin: 4, scalable: true });
  }

  window.SimClin = { conectar, enviar, idDispositivo, reloj, ICONOS, mezclarColor, escapar, qrSVG };
})();
