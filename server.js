const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const os = require("os");
const path = require("path");

const app = express();
const port = 3001;

const pool = new Pool({
  host: "10.172.1.10",
  database: "db1",
  user: "WEBSUP",
  password: "ManutencaoWEBRemoto",
  port: 5432,
});

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// Middleware para log de rotas
app.use((req, res, next) => {
  console.log(`[ROTA ACESSADA] ${req.method} ${req.url}`);
  next();
});

// Cache para os endpoints
let dadosCache = {
  leitos: [],
  temposPsa: [],
  ultimaAtualizacao: 0
};

// Controle de concorrência
let emAtualizacao = false;

// Função para atualizar dados de leitos
async function atualizarDadosLeitos() {
  try {
    console.log("[LEITOS] Iniciando atualização...");
    const query = `
      SELECT
          cc.nomecc,
          COUNT(CASE WHEN c.tipobloq <> 'D' THEN c.codlei ELSE NULL END) AS leitos_efetivos,
          COUNT(CASE WHEN c.tipobloq = '*' THEN c.codlei ELSE NULL END) AS leitos_ocupados,
          CASE 
              WHEN COUNT(CASE WHEN c.tipobloq <> 'D' THEN c.codlei ELSE NULL END) = 0 
              THEN 0
              ELSE LEAST(
                  ROUND(
                      (COUNT(CASE WHEN c.tipobloq = '*' THEN c.codlei ELSE NULL END) * 100.0) /
                      NULLIF(COUNT(CASE WHEN c.tipobloq <> 'D' THEN c.codlei ELSE NULL END), 0), 
                  2),
                  120
              )
          END AS taxa_de_ocupacao
      FROM cadlei c
      JOIN cadaco ca ON c.codaco = ca.codaco
      JOIN cadcc cc ON ca.codcc = cc.codcc
      GROUP BY cc.nomecc
      ORDER BY cc.nomecc;
    `;

    const result = await pool.query(query);
    dadosCache.leitos = result.rows;
    console.log(`[LEITOS] Atualização concluída. ${result.rows.length} registros.`);
  } catch (error) {
    console.error("[LEITOS] Erro na atualização:", error);
  }
}

// Função principal para atualizar tempos PSA
async function atualizarTemposPsa() {
  try {
    dadosCache.temposPsa = [];
    console.log("[PSA] Executando consulta no banco...");
    const result = await pool.query(`
      WITH ranked AS (
        SELECT
            t.classrisco,
            m.seqsenha,
            g.codpac,
            g.senha,
            m.dtentrada,
            EXTRACT(EPOCH FROM (NOW() - m.dtentrada)) / 60 AS tempo_espera,
            ROW_NUMBER() OVER (
                PARTITION BY t.classrisco
                ORDER BY EXTRACT(EPOCH FROM (NOW() - m.dtentrada)) / 60 DESC
            ) AS rn
        FROM movsenha m
        JOIN triagem t ON t.seqsenha = m.seqsenha
        JOIN gersenha g ON g.seqsenha = m.seqsenha
        WHERE
            m.codfila = '10'
            AND m.situacao = '0'
            AND m.dtentrada >= NOW() - INTERVAL '4 hours'
            AND NOT EXISTS (
                SELECT 1
                FROM arqatend a
                JOIN evomed e ON e.numatend = a.numatend
                WHERE a.seqsenha = m.seqsenha
            )
      ),
      agg AS (
        SELECT
            classrisco,
            COUNT(*) AS qtd_pacientes,
            ROUND(MAX(tempo_espera)) AS tempo_maximo_espera_minutos,
            ROUND(AVG(tempo_espera)) AS media_tempo_espera_minutos
        FROM ranked
        GROUP BY classrisco
      ),
      max_paciente AS (
        SELECT
            classrisco,
            codpac,
            senha
        FROM ranked
        WHERE rn = 1
      )
      SELECT
          a.classrisco || ' - ' || 
          CASE a.classrisco
              WHEN 4 THEN 'Azul'
              WHEN 0 THEN 'Vermelho'
              WHEN 2 THEN 'Amarelo'
              WHEN 3 THEN 'Verde'
              ELSE 'Desconhecido'
          END AS classificacao,
          a.qtd_pacientes,
          a.tempo_maximo_espera_minutos,
          a.media_tempo_espera_minutos,
          COALESCE(cp.nomepac, 'Paciente não identificado') AS "PACIENTE AGUARDANDO A MAIS TEMPO",
          COALESCE(CAST(mp.senha AS TEXT), 'Sem senha registrada') AS "SENHA PACIENTE AGUARDANDO"
      FROM agg a
      LEFT JOIN max_paciente mp ON mp.classrisco = a.classrisco
      LEFT JOIN cadpac cp ON cp.codpac = mp.codpac
      ORDER BY a.classrisco ASC;
    `);

    dadosCache.temposPsa = result.rows.map(row => ({ ...row }));
    dadosCache.ultimaAtualizacao = Date.now();
    console.log(`[PSA] Dados atualizados. ${result.rows.length} registros.`);
  } catch (err) {
    console.error("[PSA] Erro na atualização:", err);
    dadosCache.temposPsa = [];
  }
}

// Wrapper seguro para atualização
async function atualizarTemposPsaSeguro() {
  if (emAtualizacao) {
    console.log("[PSA] Atualização já em andamento. Ignorando...");
    return;
  }

  try {
    emAtualizacao = true;
    await atualizarTemposPsa();
  } finally {
    emAtualizacao = false;
  }
}

// Adicione este endpoint ao server.js, preferencialmente próximo ao endpoint /cirurgias
app.get('/repcir', async (req, res) => {
  const { dataInicio, dataFim } = req.query;

  // Validação das datas
  if (!dataInicio || !dataFim) {
    return res.status(400).json({ 
      status: "error", 
      message: "Datas de início e fim são obrigatórias" 
    });
  }

  try {
    // Formata as datas para o padrão do banco (com fuso horário)
    const dataInicioFormatada = `${dataInicio} 00:00:01.724 -0300`;
    const dataFimFormatada = `${dataFim} 23:59:59.724 -0300`;

    // SUA QUERY MODIFICADA (com parâmetros dinâmicos)
    const query = `
      SELECT
          c.cirurgiao1 AS codigo_cirurgiao,
          p.nomeprest AS nome_cirurgiao,
          c.numatend AS numero_atendimento,
          COUNT(c.codcir) AS total_cirurgias,
          (
              SELECT STRING_AGG(TO_CHAR(sc.dataini, 'DD/MM/YYYY'), ', ')
              FROM arqcir sc
              WHERE sc.cirurgiao1 = c.cirurgiao1
                AND sc.numatend = c.numatend
                AND sc.dataini BETWEEN $1 AND $2
          ) AS datas_cirurgias,
          (
              SELECT STRING_AGG(
                         CASE cd.portepmg
                             WHEN 'P' THEN 'Pequeno'
                             WHEN 'M' THEN 'Médio'
                             WHEN 'G' THEN 'Grande'
                             ELSE cd.portepmg
                         END, ', '
                     )
              FROM arqcir sp
              JOIN cadcir cd ON sp.codcir = cd.codcir
              WHERE sp.cirurgiao1 = c.cirurgiao1
                AND sp.numatend = c.numatend
                AND sp.dataini BETWEEN $1 AND $2
          ) AS portes_cirurgicos
      FROM arqcir c
      JOIN cadprest p ON c.cirurgiao1 = p.codprest
      WHERE c.dataini BETWEEN $1 AND $2
      GROUP BY c.cirurgiao1, p.nomeprest, c.numatend
      ORDER BY p.nomeprest;
    `;

    // Executa a query com os parâmetros
    const result = await pool.query(query, [dataInicioFormatada, dataFimFormatada]);

    res.json({
      status: "success",
      data: result.rows,
      metadata: {
        gerado_em: new Date().toISOString(),
        periodo: `${dataInicio} até ${dataFim}`
      }
    });

  } catch (error) {
    console.error("[REPCIR] Erro na consulta:", error);
    res.status(500).json({
      status: "error",
      message: "Erro ao buscar dados de repasses",
      details: error.message
    });
  }
});

// Endpoint para cirurgias - versão corrigida
app.get('/cirurgias', async (req, res) => {
  const { dataInicio, dataFim } = req.query;
  
  if (!dataInicio || !dataFim) {
    return res.status(400).json({
      status: "error",
      message: "Datas de início e fim são obrigatórias no formato YYYY-MM-DD"
    });
  }

  // Validação do formato da data
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dataInicio) || !dateRegex.test(dataFim)) {
    return res.status(400).json({
      status: "error",
      message: "Formato de data inválido. Use YYYY-MM-DD"
    });
  }

  try {
    const dataInicioFormatada = `${dataInicio} 00:00:01.000`;
    const dataFimFormatada = `${dataFim} 23:59:59.000`;

    console.log(`[CIRURGIAS] Consultando de ${dataInicioFormatada} até ${dataFimFormatada}`);

    const query = `
      SELECT
          cadespci.descrespci AS especialidade,
          COUNT(*) AS total_cirurgias,
          SUM(CASE WHEN arqcir.carater = 'E' THEN 1 ELSE 0 END) AS total_eletivas,
          SUM(CASE WHEN arqcir.carater = 'U' THEN 1 ELSE 0 END) AS total_urgencias,
          (SUM(CASE WHEN arqcir.carater = 'U' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)) AS taxa_de_urgencia
      FROM arqcir
      JOIN cadcir ON arqcir.codcir = cadcir.codcir
      JOIN cadespci ON cadcir.codespcir = cadespci.codespci
      JOIN cadprest ON arqcir.cirurgiao1 = cadprest.codprest
      WHERE arqcir.dataini BETWEEN $1 AND $2
      GROUP BY cadespci.descrespci
      UNION ALL
      SELECT 'TOTAL GERAL' AS especialidade,
          COUNT(*) AS total_cirurgias,
          SUM(CASE WHEN arqcir.carater = 'E' THEN 1 ELSE 0 END) AS total_eletivas,
          SUM(CASE WHEN arqcir.carater = 'U' THEN 1 ELSE 0 END) AS total_urgencias,
          (SUM(CASE WHEN arqcir.carater = 'U' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)) AS taxa_de_urgencia
      FROM arqcir
      JOIN cadcir ON arqcir.codcir = cadcir.codcir
      JOIN cadespci ON cadcir.codespcir = cadespci.codespci
      JOIN cadprest ON arqcir.cirurgiao1 = cadprest.codprest
      WHERE arqcir.dataini BETWEEN $1 AND $2;
    `;

    const result = await pool.query(query, [dataInicioFormatada, dataFimFormatada]);
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    res.json({
      status: "success",
      data: result.rows,
      ultimaAtualizacao: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("[CIRURGIAS] Erro na consulta:", error);
    res.status(500).json({
      status: "error",
      message: "Erro ao buscar dados de cirurgias",
      details: error.message
    });
  }
});

// Configuração dos intervalos de atualização
function iniciarAtualizacoesPeriodicas() {
  setInterval(() => {
    const agora = Date.now();
    const tempoDesdeUltimaAtualizacao = agora - dadosCache.ultimaAtualizacao;
    if (tempoDesdeUltimaAtualizacao >= 30000) {
      console.log(`[PSA] Trigger de atualização (${tempoDesdeUltimaAtualizacao/1000}s desde última)`);
      atualizarTemposPsaSeguro();
    }
  }, 5000);

  setInterval(atualizarDadosLeitos, 7200000);
}

// Endpoints existentes
app.get("/dados", (req, res) => {
  res.json(dadosCache.leitos);
});

app.get('/tempos_psa', (req, res) => {
  res.json({
    ultimaAtualizacao: new Date(dadosCache.ultimaAtualizacao).toISOString(),
    dados: dadosCache.temposPsa
  });
});

app.get('/tempos_psa/status', (req, res) => {
  res.json({
    status: emAtualizacao ? 'em_atualizacao' : 'ativo',
    ultimaAtualizacao: new Date(dadosCache.ultimaAtualizacao).toISOString(),
    tempoDecorrido: `${(Date.now() - dadosCache.ultimaAtualizacao)/1000} segundos`,
    registros: dadosCache.temposPsa.length
  });
});

app.get('/tempos_psa/refresh', async (req, res) => {
  try {
    console.log("[PSA] Atualização manual solicitada");
    await atualizarTemposPsaSeguro();
    res.json({
      status: "success",
      ultimaAtualizacao: new Date(dadosCache.ultimaAtualizacao).toISOString(),
      registros: dadosCache.temposPsa.length
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Falha na atualização manual"
    });
  }
});


app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Inicialização do servidor
async function iniciarServidor() {
  await atualizarDadosLeitos();
  await atualizarTemposPsaSeguro();
  iniciarAtualizacoesPeriodicas();

  app.listen(port, "0.0.0.0", () => {
    console.log(`Servidor rodando em http://${getLocalIP()}:${port}`);
    console.log("Endpoints disponíveis:");
    console.log("- /tempos_psa          (dados PSA)");
    console.log("- /tempos_psa/status   (status da atualização)");
    console.log("- /tempos_psa/refresh  (atualização manual)");
    console.log("- /dados               (dados de leitos)");
    console.log("- /cirurgias           (dados de cirurgias)");
  });
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (let iface of Object.values(interfaces)) {
    for (let config of iface) {
      if (config.family === "IPv4" && !config.internal) {
        return config.address;
      }
    }
  }
  return "127.0.0.1";
}

iniciarServidor().catch(err => {
  console.error("Falha ao iniciar servidor:", err);
  process.exit(1);
});