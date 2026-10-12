// Motor de voz da Maria Portuguesa (lado do navegador).
//
// Trata de tudo o que é áudio e rede, para o Flutter só ter de desenhar:
//   microfone → PCM 16 bit / 16 kHz → WebSocket /maria-portuguesa/voz
//   WebSocket → PCM 16 bit / 24 kHz → altifalantes
//
// O Flutter chama window.MariaVoz.iniciar(url, aoEstado, aoMensagem, aoNivel):
//   aoEstado(texto)        "a-ligar" | "a-ouvir" | "a-falar" | "parado"
//   aoMensagem(json)       mensagens de texto do servidor (transcrições, resultados,
//                          erros), mais {"type":"sem_microfone"} gerada aqui
//   aoNivel(mic, voz)      volumes de 0 a 1, para animar o avatar
(function () {
  'use strict';

  // Corre no fio de áudio: converte o microfone para 16 kHz e entrega blocos de 100 ms.
  const CODIGO_CAPTURA = `
    class CapturaMaria extends AudioWorkletProcessor {
      constructor() {
        super();
        this.passo = sampleRate / 16000;
        this.posicao = 0;
        this.bloco = new Int16Array(1600);
        this.usado = 0;
        this.energia = 0;
      }
      process(entradas) {
        const canal = entradas[0] && entradas[0][0];
        if (!canal) return true;
        while (this.posicao < canal.length) {
          const i = Math.floor(this.posicao);
          const fracao = this.posicao - i;
          const seguinte = i + 1 < canal.length ? canal[i + 1] : canal[i];
          const amostra = Math.max(-1, Math.min(1, canal[i] + (seguinte - canal[i]) * fracao));
          this.bloco[this.usado++] = amostra < 0 ? amostra * 0x8000 : amostra * 0x7fff;
          this.energia += amostra * amostra;
          if (this.usado === this.bloco.length) {
            const pronto = this.bloco;
            this.port.postMessage({ pcm: pronto.buffer, nivel: Math.sqrt(this.energia / pronto.length) }, [pronto.buffer]);
            this.bloco = new Int16Array(1600);
            this.usado = 0;
            this.energia = 0;
          }
          this.posicao += this.passo;
        }
        this.posicao -= canal.length;
        return true;
      }
    }
    registerProcessor('captura-maria', CapturaMaria);
  `;

  let sessao = null;

  function terminar() {
    const s = sessao;
    if (!s) return;
    sessao = null;
    cancelAnimationFrame(s.quadro);
    try { s.ws && s.ws.close(); } catch (_) {}
    if (s.microfone) s.microfone.getTracks().forEach((faixa) => faixa.stop());
    try { s.contexto.close(); } catch (_) {}
    s.aoNivel(0, 0);
    s.aoEstado('parado');
  }

  async function iniciar(url, aoEstado, aoMensagem, aoNivel) {
    terminar();
    const Contexto = window.AudioContext || window.webkitAudioContext;
    if (!Contexto || !window.WebSocket) {
      aoMensagem(JSON.stringify({ type: 'error', message: 'Este navegador não suporta conversa por voz.' }));
      aoEstado('parado');
      return;
    }

    const s = sessao = {
      aoEstado, aoMensagem, aoNivel,
      contexto: new Contexto(),
      pronta: false,          // o servidor já disse "ready"
      fontes: new Set(),      // pedaços de fala ainda a tocar
      proximoInicio: 0,
      nivelMic: 0,
      houveErro: false,
    };
    aoEstado('a-ligar');
    // Chamado dentro do toque do utilizador: é isto que autoriza o som.
    s.contexto.resume();

    s.saida = s.contexto.createGain();
    s.medidor = s.contexto.createAnalyser();
    s.medidor.fftSize = 512;
    s.saida.connect(s.medidor);
    s.medidor.connect(s.contexto.destination);

    const estadoAtual = () => (s.fontes.size > 0 ? 'a-falar' : 'a-ouvir');

    // ── Ligação ao servidor ──
    const ws = s.ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (evento) => {
      if (sessao !== s) return;
      if (typeof evento.data !== 'string') {
        tocar(evento.data);
        return;
      }
      let mensagem;
      try { mensagem = JSON.parse(evento.data); } catch (_) { return; }
      if (mensagem.type === 'ready') {
        s.pronta = true;
        aoEstado(estadoAtual());
      } else if (mensagem.type === 'interrupted') {
        calar();
      } else if (mensagem.type === 'error') {
        s.houveErro = true;
      }
      aoMensagem(evento.data);
    };

    ws.onclose = () => {
      if (sessao !== s) return;
      if (!s.houveErro && !s.pronta) {
        aoMensagem(JSON.stringify({ type: 'error', message: 'Não foi possível ligar à Maria. Pode escrever o seu pedido.' }));
      }
      terminar();
    };

    // ── Altifalantes ──
    function tocar(dados) {
      const pcm = new Int16Array(dados);
      if (!pcm.length) return;
      const amostras = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) amostras[i] = pcm[i] / 0x8000;
      const pedaco = s.contexto.createBuffer(1, amostras.length, 24000);
      pedaco.copyToChannel(amostras, 0);

      const fonte = s.contexto.createBufferSource();
      fonte.buffer = pedaco;
      fonte.connect(s.saida);
      const inicio = Math.max(s.contexto.currentTime + 0.02, s.proximoInicio);
      fonte.start(inicio);
      s.proximoInicio = inicio + pedaco.duration;
      s.fontes.add(fonte);
      fonte.onended = () => {
        s.fontes.delete(fonte);
        if (sessao === s && s.fontes.size === 0) aoEstado('a-ouvir');
      };
      if (s.fontes.size === 1) aoEstado('a-falar');
    }

    // A pessoa falou por cima da Maria: pára tudo o que estava em fila.
    function calar() {
      s.fontes.forEach((fonte) => { try { fonte.stop(); } catch (_) {} });
      s.fontes.clear();
      s.proximoInicio = 0;
      aoEstado('a-ouvir');
    }

    // ── Volumes para o avatar ──
    const onda = new Float32Array(s.medidor.fftSize);
    (function medir() {
      if (sessao !== s) return;
      s.medidor.getFloatTimeDomainData(onda);
      let soma = 0;
      for (let i = 0; i < onda.length; i++) soma += onda[i] * onda[i];
      aoNivel(Math.min(1, s.nivelMic * 6), Math.min(1, Math.sqrt(soma / onda.length) * 5));
      s.nivelMic *= 0.85;
      s.quadro = requestAnimationFrame(medir);
    })();

    // ── Microfone ──
    try {
      if (!navigator.mediaDevices || !s.contexto.audioWorklet) throw new Error('sem suporte');
      const microfone = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (sessao !== s) { microfone.getTracks().forEach((faixa) => faixa.stop()); return; }
      s.microfone = microfone;

      const modulo = URL.createObjectURL(new Blob([CODIGO_CAPTURA], { type: 'application/javascript' }));
      await s.contexto.audioWorklet.addModule(modulo);
      URL.revokeObjectURL(modulo);
      if (sessao !== s) return;

      const captura = new AudioWorkletNode(s.contexto, 'captura-maria');
      captura.port.onmessage = (evento) => {
        if (sessao !== s) return;
        s.nivelMic = Math.max(s.nivelMic, evento.data.nivel);
        if (s.pronta && ws.readyState === WebSocket.OPEN) ws.send(evento.data.pcm);
      };
      // O nó só é processado se estiver ligado à saída; passa por um ganho a zero
      // para o microfone não se ouvir nos altifalantes.
      const mudo = s.contexto.createGain();
      mudo.gain.value = 0;
      s.contexto.createMediaStreamSource(microfone).connect(captura);
      captura.connect(mudo);
      mudo.connect(s.contexto.destination);
    } catch (_) {
      // Sem microfone a conversa continua: a pessoa ouve a Maria e escreve.
      if (sessao === s) aoMensagem(JSON.stringify({ type: 'sem_microfone' }));
    }
  }

  function enviarTexto(texto) {
    const s = sessao;
    if (!s || !s.pronta || s.ws.readyState !== WebSocket.OPEN) return false;
    s.ws.send(JSON.stringify({ type: 'text', text: texto }));
    return true;
  }

  window.MariaVoz = { iniciar, enviarTexto, terminar };
})();
