# Gestão da Barbearia

Sistema de gestão para a barbearia: caixa do dia, comissões dos barbeiros, clientes, fiado, contas a pagar, planos mensais e relatórios. Ele já importa os dados do app antigo, então todo o histórico continua disponível.

Não precisa instalar nada além do **Node.js 22.13 ou mais novo**. O sistema não tem dependências externas.

## Como usar

**No Windows:** instale o Node.js (versão LTS em nodejs.org) e dê dois cliques em `iniciar.bat`, dentro da pasta `barbearia`. O navegador abre em `http://localhost:3100`.

**Pelo terminal:**

```bash
cd barbearia
npm start            # abre em http://localhost:3100
```

No primeiro acesso, você cria a senha. Depois, em **Dados e ajustes → Trazer dados do app antigo**, envie o `.zip` exportado do app antigo. Também dá para importar pelo terminal:

```bash
npm run importar -- caminho/dados-barbearia.zip
```

A importação pode ser repetida com uma exportação mais nova: os registros mantêm o mesmo código do app antigo, então nada é duplicado, e o que foi lançado no sistema novo continua intacto. Antes de cada importação, o sistema faz um backup.

## Barbeiros usando pelo celular

### 1. Dar acesso a cada barbeiro

Entre como dono e vá em **Cadastros → Barbeiros → Editar**. Defina um **PIN** de 4 a 6 números para cada barbeiro. Na tela de entrada, ele toca no próprio nome e digita o PIN.

| O barbeiro pode | O barbeiro **não** pode |
|---|---|
| Lançar os próprios cortes (dinheiro, PIX, cartão, plano, fiado) | Lançar em nome de outro barbeiro |
| Ver o próprio dia, a comissão e quanto falta receber | Ver o caixa geral, o lucro, os colegas, as contas e os backups |
| Cadastrar cliente novo (nome e telefone) | Lançar entradas e saídas |
| Apagar o que **ele mesmo** lançou **hoje** (para corrigir erro) | Apagar lançamento antigo ou de outra pessoa |

O dono vê tudo o que os barbeiros lançam, na hora. Para tirar o acesso de alguém, marque "Tirar o acesso dele ao app" ou desative o barbeiro. Ele sai na mesma hora.

### 2. Instalar como aplicativo

Abra o endereço do sistema no celular:
- **Android (Chrome):** menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").
- **iPhone (Safari):** botão de compartilhar → **Adicionar à Tela de Início**.

O ícone da tesoura aparece na tela inicial, e o sistema abre em tela cheia, como um aplicativo. Cada celular lembra quem entrou por último.

### 3. Onde o sistema fica rodando

**Opção A: só no Wi-Fi da barbearia (grátis).** O computador da barbearia fica ligado com o `iniciar.bat` aberto. Os celulares conectados ao mesmo Wi-Fi acessam pelo IP do computador, por exemplo `http://192.168.0.10:3100`. Para descobrir o IP no Windows, rode `ipconfig` e veja "Endereço IPv4". O limite dessa opção é que, se o computador desligar ou o celular sair do Wi-Fi, o app para de funcionar.

**Opção B: na internet (recomendado, cerca de US$ 5 por mês).** O app funciona em qualquer lugar, inclusive no 4G, e não depende do computador. Exemplo com o **Railway** (railway.app):

1. Crie uma conta e escolha **New Project → Deploy from GitHub repo**. Escolha este repositório e, em Settings, defina **Root Directory = `barbearia`**. O Railway usa o `Dockerfile` da pasta.
2. Em **Volumes**, crie um volume montado em **`/data`**. É ali que ficam os dados. **Sem o volume, os dados se perdem a cada atualização.**
3. Em **Settings → Networking**, gere o domínio público. Você recebe um endereço `https://...up.railway.app`.
4. Abra o endereço, crie a senha do dono e importe o .zip em **Dados e ajustes**.

Funciona do mesmo jeito no Render ou no Fly.io, desde que haja um disco persistente montado em `/data`. Mesmo com o app na internet, baixe um backup de vez em quando em **Dados e ajustes**.

## O que tem

| Aba | O que faz |
|---|---|
| Caixa | Lança o corte em poucos toques: escolhe o barbeiro, os serviços (soma sozinho) e a forma de pagamento. Calcula a comissão e a taxa da maquininha. Também lança venda de produto (baixa o estoque) e saídas. Tem abertura e fechamento de caixa, mostrando quanto dinheiro deve ter na gaveta |
| Painel | Faturamento, cortes, ticket médio, comissões, despesas e quanto sobrou, em qualquer período. Também mostra o faturamento por dia, por barbeiro e por forma de pagamento, a média por dia da semana, o movimento por horário e o mês a mês de todo o histórico |
| Comissões | Por barbeiro: comissão gerada, quanto já foi pago e quanto falta pagar. Botões para pagar a comissão, dar vale, lançar comissão extra e ver o extrato |
| Clientes | Visitas, quanto gastou, última visita (avisa quem sumiu há mais de 30 dias), fiado em aberto, plano e link para o WhatsApp |
| Fiado | O que está em aberto e o que já foi pago. Ao receber, o valor entra no caixa com a comissão |
| Contas | Contas a pagar com aviso das vencidas e das que vencem logo. Quando uma conta mensal é paga, a do mês seguinte já é criada |
| Planos | Planos mensais com o uso do mês (ex.: 3 de 4 cortes) e o registro da mensalidade |
| Lançamentos | Todos os lançamentos, com filtros. Também baixa a planilha (CSV) |
| Cadastros | Barbeiros, serviços com preço e % de comissão, produtos com estoque |
| Dados e ajustes | Importação, backup, taxas da maquininha, nome da barbearia e senha |

## Como as contas são feitas

- **Faturamento** = serviços + entradas extras (venda de produto, mensalidade de plano, gorjeta).
- **Comissões** = comissão gerada em cada corte + comissões extras.
- **Despesas** = saídas do caixa + contas a pagar quitadas no período. As taxas da maquininha aparecem separadas.
- **Sobrou** = faturamento − comissões − taxas − despesas.
- **Pagamento de comissão e vale** não contam como despesa, porque a comissão já foi descontada. Eles só abatem o "falta pagar" de cada barbeiro.

> O resumo do app antigo descontava esses pagamentos de comissão (e as taxas) duas vezes, mas deixava de fora as contas a pagar (aluguel, água etc.). Por isso, o "sobrou" mês a mês do sistema novo é diferente do antigo. Exemplo: em setembro, o antigo mostrava R$ 1.144,00 e o real é R$ 2.461,00.

## Seus dados

- Tudo fica no arquivo `barbearia/dados/barbearia.db`, no seu computador. Essa pasta **não vai para o GitHub**: o repositório é público e os dados têm nomes e telefones de clientes.
- O sistema faz **um backup automático por dia** em `barbearia/dados/backups/` e guarda os 60 mais recentes.
- Em **Dados e ajustes → Baixar backup agora**, você baixa uma cópia. Guarde uma fora do computador, por exemplo no Google Drive ou num pen drive.
- Para restaurar um backup: feche o sistema, troque o `dados/barbearia.db` pelo arquivo de backup (renomeado para `barbearia.db`) e abra de novo.
