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

### Usar no celular dos barbeiros

Com o computador ligado e o sistema aberto, os celulares **na mesma rede Wi-Fi** acessam pelo IP do computador, por exemplo `http://192.168.0.10:3100`. Para descobrir o IP no Windows, rode `ipconfig` e veja "Endereço IPv4". No celular, use "Adicionar à tela inicial" para o sistema aparecer como um aplicativo.

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
