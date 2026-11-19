# Gestão da Barbearia

Sistema de gestão para a barbearia: caixa do dia, comissões dos barbeiros, clientes, fiado, contas a pagar, planos mensais e relatórios. Ele importa os dados do app antigo, então todo o histórico continua disponível.

O app funciona como aplicativo no celular e cada barbeiro tem o próprio acesso. Ele roda **de graça no Cloudflare**, em qualquer lugar e até no 4G, ou no computador da barbearia.

## Colocar no ar de graça (Cloudflare)

Você só precisa fazer isso uma vez. Não pede cartão de crédito.

1. Crie uma conta grátis em **dash.cloudflare.com/sign-up** (só e-mail e senha) e confirme o e-mail.
2. No painel, abra **Workers e Pages** (*Workers & Pages*, no menu "Computação") e clique em **Criar** (*Create*).
3. Escolha **Importar um repositório** (*Import a repository*) e conecte o **GitHub**. Autorize o Cloudflare a ver o repositório `FERRAMENTA-V-DEO-UGH`.
4. Escolha o repositório. Na tela de configuração:
   - **Nome do projeto** (*Project name*): `ferramenta-v-deo-ugh` (tem que ser igual ao `name` do `wrangler.jsonc`)
   - **Diretório raiz** (*Root directory*, em "Configurações avançadas"): `barbearia`
   - **Comando de deploy** (*Deploy command*): deixe `npx wrangler deploy`
   - **Branch:** a branch onde está o app (`claude/fervent-hawking-kef530`, ou `main` depois de juntar)
5. Clique em **Implantar** (*Deploy*) e espere 1 a 2 minutos. O banco de dados é criado sozinho.
6. Você recebe um endereço parecido com **`https://ferramenta-v-deo-ugh.SEU-NOME.workers.dev`**. É o endereço do app.
7. Abra o endereço, crie a **senha do dono** (pelo menos 6 caracteres) e vá em **Dados e ajustes → Trazer dados do app antigo**. Envie o `.zip` do app antigo. A importação leva poucos segundos.

Depois disso, toda alteração enviada ao GitHub nessa branch atualiza o app sozinha. Os dados não são apagados.

### Limites do plano grátis

O plano grátis aguenta com folga o movimento de uma barbearia:

| Limite grátis | Uso da barbearia |
|---|---|
| 100 mil acessos por dia | algumas centenas |
| 500 MB de banco de dados | menos de 1 MB por ano de dados |
| 5 milhões de linhas lidas no banco por dia | dezenas de milhares (cada abertura do Painel lê o histórico) |
| 100 mil linhas gravadas por dia | algumas centenas (a importação inicial grava cerca de 2.500) |

## Barbeiros usando pelo celular

### Dar acesso a cada barbeiro

Entre como dono e vá em **Cadastros → Barbeiros → Editar**. Defina um **PIN** de 4 a 6 números para cada barbeiro. Na tela de entrada, ele toca no próprio nome e digita o PIN.

| O barbeiro pode | O barbeiro **não** pode |
|---|---|
| Lançar os próprios cortes (dinheiro, PIX, cartão, plano, fiado) | Lançar em nome de outro barbeiro |
| Ver o próprio dia, a comissão e quanto falta receber | Ver o caixa geral, o lucro, os colegas, as contas e os backups |
| Cadastrar cliente novo (nome e telefone) | Lançar entradas e saídas |
| Apagar o que **ele mesmo** lançou **hoje** (para corrigir erro) | Apagar lançamento antigo ou de outra pessoa |

O dono vê na hora tudo o que os barbeiros lançam. Para tirar o acesso de alguém, marque "Tirar o acesso dele ao app" ou desative o barbeiro. Ele perde o acesso na mesma hora.

Depois de 6 PINs errados, o acesso daquele barbeiro fica travado por 15 minutos. Com a senha do dono acontece o mesmo depois de 8 erros. Isso impede que alguém fique chutando a senha.

### Instalar como aplicativo

Abra o endereço do app no celular:
- **Android (Chrome):** menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").
- **iPhone (Safari):** botão de compartilhar → **Adicionar à Tela de Início**.

O ícone da tesoura aparece na tela inicial e o app abre em tela cheia. Cada celular lembra quem entrou por último.

## Seus dados e backups

- **No Cloudflare:** o banco guarda sozinho todas as alterações dos últimos 7 dias. Com isso, dá para voltar o banco a qualquer momento dessa semana (no painel, em **Armazenamento e bancos de dados → D1 → gestao-barbearia → Time Travel**).
- **Backup semanal:** em **Dados e ajustes → Baixar backup agora**, você baixa um arquivo `.json` com tudo. Guarde no Google Drive ou mande para o seu e-mail. Se passar 7 dias sem baixar, o app avisa na tela do Caixa.
- **Restaurar:** em **Dados e ajustes → Restaurar um backup**, você envia o `.json`. O que foi apagado volta, e o que foi lançado depois do backup continua.
- **Planilha:** o botão **Planilha de lançamentos (CSV)** baixa todos os lançamentos para abrir no Excel ou no Google Planilhas.
- Os dados **não ficam no GitHub**. O repositório é público e os dados têm nomes e telefones de clientes.

## O que tem no app

| Aba | O que faz |
|---|---|
| Caixa | Lança o corte em poucos toques: barbeiro, serviços (o total soma sozinho) e forma de pagamento. Calcula a comissão e a taxa da maquininha. Também lança venda de produto (baixa o estoque) e saídas. Tem abertura e fechamento de caixa, mostrando quanto dinheiro deve ter na gaveta |
| Painel | Faturamento, cortes, ticket médio, comissões, despesas e quanto sobrou, em qualquer período. Mostra também o faturamento por dia, por barbeiro e por forma de pagamento, a média por dia da semana, o movimento por horário e o mês a mês de todo o histórico |
| Comissões | Por barbeiro: comissão gerada, quanto já foi pago e quanto falta pagar. Tem botões para pagar a comissão, dar vale, lançar comissão extra e ver o extrato |
| Clientes | Visitas, quanto gastou, última visita (avisa quem sumiu há mais de 30 dias), fiado em aberto, plano e link para o WhatsApp |
| Fiado | O que está em aberto e o que já foi pago. Ao receber, o valor entra no caixa com a comissão do barbeiro |
| Contas | Contas a pagar com aviso das vencidas. Quando uma conta mensal é paga, a do mês seguinte já é criada |
| Planos | Planos mensais com o uso do mês (ex.: 3 de 4 cortes) e o registro da mensalidade |
| Lançamentos | Todos os lançamentos, com filtros, e a planilha para baixar |
| Cadastros | Barbeiros (com PIN de acesso), serviços com preço e % de comissão, produtos com estoque |
| Dados e ajustes | Importação, backup, taxas da maquininha, nome da barbearia e senha |

## Como as contas são feitas

- **Faturamento** = serviços + entradas extras (venda de produto, mensalidade de plano, gorjeta).
- **Comissões** = comissão gerada em cada corte + comissões extras.
- **Despesas** = saídas do caixa + contas a pagar quitadas no período. As taxas da maquininha aparecem separadas.
- **Sobrou** = faturamento − comissões − taxas − despesas.
- **Pagamento de comissão e vale** não contam como despesa, porque a comissão já foi descontada. Eles só abatem o "falta pagar" de cada barbeiro.

> O resumo do app antigo descontava os pagamentos de comissão (e as taxas) duas vezes e deixava de fora as contas a pagar (aluguel, água etc.). Por isso, o "sobrou" mês a mês do app novo é diferente. Em setembro, por exemplo, o antigo mostrava R$ 1.144,00, e o valor certo é R$ 2.461,00.

## Opção sem internet: rodar no computador da barbearia

Com o **Node.js 22.13 ou mais novo** instalado (versão LTS em nodejs.org), dê dois cliques em `iniciar.bat`. O app abre em `http://localhost:3100`. Os celulares conectados ao **mesmo Wi-Fi** acessam pelo IP do computador, por exemplo `http://192.168.0.10:3100`. Para descobrir o IP no Windows, rode `ipconfig` e veja "Endereço IPv4".

Nesse modo, os dados ficam em `barbearia/dados/barbearia.db` e o app faz um backup automático por dia em `barbearia/dados/backups/`. Os dois modos são independentes: os dados do computador não vão sozinhos para o Cloudflare. Para levar os dados de um para o outro, baixe o backup num e restaure no outro.

Pelo terminal:

```bash
cd barbearia
npm start                                   # computador: http://localhost:3100
npm run importar -- caminho/dados.zip       # importa o .zip no banco do computador
npx wrangler dev                            # simula o Cloudflare no computador
```

## Para quem for mexer no código

| Arquivo | O que faz |
|---|---|
| `src/api.js` | Toda a lógica e as rotas `/api/*` (Request/Response padrão, igual no Cloudflare e no Node) |
| `src/schema.js` | Estrutura do banco, criada sozinha no primeiro acesso |
| `src/worker.js` | Entrada no Cloudflare (Worker + D1) |
| `src/db-d1.js`, `src/db-node.js` | Adaptadores do banco (D1 e SQLite local) |
| `server.js`, `importar.js` | Servidor e importação no computador |
| `public/` | Telas (HTML, CSS e JS sem frameworks), ícones e o necessário para instalar no celular |
| `wrangler.jsonc` | Configuração do Cloudflare |

O código respeita os limites do plano grátis do Cloudflare: poucas consultas por acesso, gravação em lote, e importação e backup feitos em partes, sem processar o banco inteiro num acesso só.
