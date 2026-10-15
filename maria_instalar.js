// Instalação da aplicação (PWA) no Android, usada por lib/instalacao/instalador_web.dart.
//
// O Chrome avisa com «beforeinstallprompt» quando a página pode ser instalada.
// Este aviso chega cedo, muitas vezes antes de o Flutter arrancar, por isso é
// guardado aqui para o botão «Instalar» o usar mais tarde.
(function () {
  var pedido = null;

  function avisar() {
    if (typeof window.mpInstalacaoMudou === 'function') window.mpInstalacaoMudou();
  }

  window.addEventListener('beforeinstallprompt', function (evento) {
    // Sem a barra automática do Chrome: quem convida é o botão da página.
    evento.preventDefault();
    pedido = evento;
    avisar();
  });

  window.addEventListener('appinstalled', function () {
    pedido = null;
    window.mpInstalada = true;
    avisar();
  });

  window.MariaInstalar = {
    eAndroid: function () {
      return /Android/i.test(navigator.userAgent);
    },

    // Aberta como aplicação instalada (e não num separador do navegador).
    emAplicacao: function () {
      return window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: fullscreen)').matches ||
        window.matchMedia('(display-mode: minimal-ui)').matches;
    },

    instalada: function () {
      return window.mpInstalada === true;
    },

    temPedido: function () {
      return pedido !== null;
    },

    // Mostra a janela de instalação do navegador. Resolve com 'accepted',
    // 'dismissed' ou 'indisponivel' (o navegador ainda não deu o pedido).
    instalar: function () {
      if (!pedido) return Promise.resolve('indisponivel');
      var atual = pedido;
      pedido = null; // cada pedido só se pode mostrar uma vez
      return atual.prompt()
        .then(function () { return atual.userChoice; })
        .then(function (escolha) { return escolha.outcome; })
        .catch(function () { return 'indisponivel'; });
    },

    dispensado: function () {
      try {
        return window.localStorage.getItem('mp_instalar_dispensado') === '1';
      } catch (e) {
        return false;
      }
    },

    dispensar: function () {
      try {
        window.localStorage.setItem('mp_instalar_dispensado', '1');
      } catch (e) {
        // Sem armazenamento (navegação privada): volta a aparecer na próxima visita.
      }
    },
  };
})();
