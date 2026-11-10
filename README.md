# IVI para Android (PWA)

Multimídia veicular que roda no aparelho Android (celular ou tablet no painel).
Depois da primeira abertura, a interface e a biblioteca de músicas funcionam offline, sem servidor.

## Instalar (escolha UMA opção)

### A) Hospedagem HTTPS gratuita (recomendado)
1. Suba esta pasta no GitHub Pages, Netlify Drop ou Cloudflare Pages.
2. No Chrome do Android abra o endereço, toque em ⋮ → "Instalar app" (ou "Adicionar à tela inicial").

### B) Sem internet, usando o Termux (instale pelo F-Droid)
    pkg install python
    cd /sdcard/ivi-android      # ou a pasta onde descompactou
    python -m http.server 8080
Abra http://localhost:8080 no Chrome ("localhost" conta como conexão segura, então GPS e
instalação funcionam) e instale pelo menu ⋮. Depois de instalado pode fechar o Termux.

## Primeiro uso
1. Permita a **localização** (usada para a velocidade e o bloqueio em movimento).
2. Em **Navegação**, informe o destino e toque em "Traçar rota". A posição atual é acompanhada pelo GPS.
3. Mídia → "+ Adicionar músicas" e escolha os arquivos (ficam salvos no aparelho).
4. Conecte o Bluetooth/AUX do carro normalmente pelo Android: o áudio sai por ele.

## Navegação
- O mapa e o traçado de rotas pelas vias são exibidos no app. A busca de endereço usa OpenStreetMap/Nominatim;
  o cálculo de rotas usa OSRM. Se o serviço não retornar a geometria da rota, o app informa o erro e não desenha uma linha reta.
  É necessária uma conexão com a internet para carregar o mapa e traçar rotas.
- A navegação usa os mapas do OpenStreetMap com tema escuro aplicado pelo app, adaptando-se à tela do celular Android em retrato ou paisagem. O mapa e as rotas são carregados pela internet.
- O planejamento e a interação com o mapa ficam bloqueados quando o modo GPS detecta movimento; a posição continua sendo atualizada.
- A rota mostra distância e duração estimada, mas não oferece instruções por voz nem mapas offline.

## Bloqueio em movimento (Veículo → Modo)
- GPS automático: bloqueia a lista de músicas a partir de 8 km/h ou se o GPS estiver sem sinal.
- Simulação: velocidade falsa, para testar.
- Desligado: sem bloqueio (apenas para bancada / carro parado).

## Teste da lógica
    node tests/test_util.js

## Limitações (limites do Android/Chrome)
- Ligações: o Android atende e controla; o app não mostra tela de chamada.
- Volume do sistema e brilho: use os botões do aparelho (o app controla só o volume do player).
- Sem CAN/RPM. Futuro: leitor OBD-II ELM327 via Web Bluetooth.
- Mantenha a tela ligada e o app em primeiro plano para o GPS continuar atualizando.
