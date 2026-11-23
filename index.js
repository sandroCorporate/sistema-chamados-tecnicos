import dotenv from 'dotenv';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './db.js';
import { MercadoPagoConfig, Payment } from 'mercadopago';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'chave_secreta_super_segura';

// URL do microserviço de WhatsApp dedicado (bridge local)
const WHATSAPP_SERVICE_URL = process.env.WHATSAPP_SERVICE_URL || 'http://localhost:3001';

// Constante para o destino do técnico (preparada para futuro grupo de WhatsApp)
const DESTINO_TECNICO_WHATSAPP = process.env.WHATSAPP_TECNICO_FONE || '92986040401';

// Token real do Mercado Pago integrado
const MP_TOKEN_REAL = 'APP_USR-5595843191696827-101213-f5e5271648f3f70353dbc57f81016599-332217735';

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || MP_TOKEN_REAL,
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));

// ==========================================
// FUNÇÃO AUXILIAR: Envio via Microserviço WhatsApp
// ==========================================
async function enviarNotificacaoWhatsApp(telefone, mensagem) {
  if (!telefone || telefone.trim() === '') {
    console.log('[WhatsApp Skipped] Telefone não configurado.');
    return;
  }

  let numApenasDigitos = telefone.replace(/\D/g, '');
  let jid;
  if (telefone.includes('@g.us')) {
    jid = telefone;
  } else {
    if (numApenasDigitos.length === 10 || numApenasDigitos.length === 11) {
      numApenasDigitos = '55' + numApenasDigitos;
    }
    jid = `${numApenasDigitos}@s.whatsapp.net`;
  }

  try {
    const response = await fetch(`${WHATSAPP_SERVICE_URL}/enviar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid, mensagem })
    });
    
    if (!response.ok) {
      throw new Error(`Erro HTTP: ${response.status}`);
    }
    
    console.log(`[WhatsApp Sent] Requisição de envio encaminhada para o microserviço (${jid}).`);
  } catch (error) {
    console.error('[WhatsApp Error] Falha ao comunicar com o microserviço:', error.message);
  }
}

// ==========================================
// MIDDLEWARE: Autenticação JWT
// ==========================================
function autenticarToken(req, res, next) {
  console.log(`[DEBUG REQ] ${req.method} ${req.originalUrl}`);
  
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
  }

  try {
    const usuario = jwt.verify(token, JWT_SECRET);
    req.usuario = usuario;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token inválido ou expirado.' });
  }
}

// ==========================================
// ROTAS DO SISTEMA
// ==========================================
app.get('/', (req, res) => {
  res.sendFile(process.cwd() + '/index.html');
});

app.post('/api/registro', async (req, res) => {
  const { nome, email, telefone, documento, senha } = req.body;

  if (!nome || !email || !telefone || !documento || !senha) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }

  let telLimpo = telefone.replace(/\D/g, '');
  if (telLimpo.length < 10) {
    return res.status(400).json({ error: 'Informe um número de WhatsApp válido com DDD.' });
  }

  try {
    const hashSenha = await bcrypt.hash(senha, 10);
    const empresaIdPadrao = 'a0000000-0000-0000-0000-000000000001'; // Matriz LL TECH INFO
    const query = `
      INSERT INTO usuarios (nome, email, telefone, documento, senha, senha_hash, tipo, empresa_id)
      VALUES ($1, $2, $3, $4, $5, $5, 'CLIENTE', $6)
      RETURNING id, nome, email, telefone, tipo, empresa_id;
    `;
    const result = await db.query(query, [nome, email, telLimpo, documento, hashSenha, empresaIdPadrao]);
    return res.status(201).json({ message: 'Cliente cadastrado com sucesso!', usuario: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'E-mail ou CPF/CNPJ já cadastrado.' });
    }
    res.status(500).json({ error: 'Erro interno ao registrar: ' + error.message });
  }
});

// Rota pública para a Política de Privacidade (LGPD)
app.get('/privacidade', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <title>Política de Privacidade - LL TECH INFO</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-[#0b1329] text-slate-100 p-8 min-h-screen flex justify-center items-center">
            <div class="max-w-2xl bg-slate-900/90 p-8 rounded-2xl border border-slate-800 shadow-2xl">
                <h1 class="text-2xl font-bold text-amber-500 mb-4">Política de Privacidade & LGPD</h1>
                <p class="text-sm text-slate-300 leading-relaxed mb-4">
                    A <strong>LL TECH INFO</strong> preza pela segurança e privacidade dos dados dos seus clientes. Os dados recolhidos no registo (como nome, e-mail, telefone e documento) são utilizados exclusivamente para a gestão de chamados técnicos e comunicações de atendimento via WhatsApp, em total conformidade com a Lei Geral de Proteção de Dados (LGPD).
                </p>
                <a href="/" class="inline-block px-4 py-2 bg-amber-500 text-slate-950 font-bold text-xs rounded-lg mt-4">Voltar ao Portal</a>
            </div>
        </body>
        </html>
    `);
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const { rows } = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const usuario = rows[0];
    const hashGravado = usuario.senha || usuario.senha_hash;
    const senhaValida = await bcrypt.compare(senha, hashGravado);
    if (!senhaValida) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const tipo = usuario.tipo || usuario.perfil || 'CLIENTE';
    const empresaId = usuario.empresa_id || 'a0000000-0000-0000-0000-000000000001';
    
    const payload = { id: usuario.id, email: usuario.email, tipo, empresa_id: empresaId };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      token,
      usuario: { 
        id: usuario.id, 
        nome: usuario.nome, 
        email: usuario.email, 
        tipo, 
        telefone: usuario.telefone,
        empresa_id: empresaId 
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao realizar login: ' + error.message });
  }
});

// ==========================================
// ROTA: Trocar Senha (Restrita a Técnicos)
// ==========================================
app.post('/api/usuarios/:id/trocar-senha', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { novaSenha } = req.body;

    const tipoUsuario = String(req.usuario?.tipo || '').toUpperCase();

    if (tipoUsuario === 'CLIENTE') {
      return res.status(403).json({ error: 'Acesso negado. Apenas técnicos podem alterar senhas.' });
    }

    if (!novaSenha || novaSenha.trim() === '') {
      return res.status(400).json({ error: 'A nova senha deve ser informada.' });
    }

    const userCheck = await db.query('SELECT * FROM usuarios WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Utilizador não encontrado.' });
    }

    const novoHash = await bcrypt.hash(novaSenha, 10);

    await db.query(
      'UPDATE usuarios SET senha = $1, senha_hash = $1 WHERE id = $2',
      [novoHash, id]
    );

    return res.json({ mensagem: 'Senha alterada com sucesso pelo técnico!' });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao alterar senha: ' + error.message });
  }
});

// ==========================================
// ROTA: Buscar Chamados (Filtrado por Empresa/Tenant)
// ==========================================
app.get('/api/chamados', autenticarToken, async (req, res) => {
  try {
    const tipoUsuario = String(req.usuario.tipo || '').toUpperCase();
    const empresaId = req.usuario.empresa_id || 'a0000000-0000-0000-0000-000000000001';
    
    if (tipoUsuario !== 'CLIENTE') {
      const queryTecnico = `
        SELECT c.*, 
               u.nome AS cliente_nome, 
               u.email AS cliente_email, 
               u.telefone AS cliente_telefone 
        FROM chamados c
        LEFT JOIN usuarios u ON u.id = c.usuario_id
        WHERE c.empresa_id = $1
        ORDER BY c.criado_em DESC
      `;
      try {
        const { rows } = await db.query(queryTecnico, [empresaId]);
        return res.json(rows);
      } catch (e1) {
        const queryTecnicoFallback = `
          SELECT c.*, 
                 u.nome AS cliente_nome, 
                 u.email AS cliente_email, 
                 u.telefone AS cliente_telefone 
        FROM chamados c
        LEFT JOIN usuarios u ON u.id = c.usuarioid
        WHERE c.empresa_id = $1
        ORDER BY c.criado_em DESC
        `;
        const { rows } = await db.query(queryTecnicoFallback, [empresaId]);
        return res.json(rows);
      }
    }

    let rows = [];
    try {
      const resQuery = await db.query('SELECT * FROM chamados WHERE usuario_id = $1 AND empresa_id = $2 ORDER BY criado_em DESC', [req.usuario.id, empresaId]);
      rows = resQuery.rows;
    } catch (err1) {
      try {
        const resQuery = await db.query('SELECT * FROM chamados WHERE usuarioid = $1 AND empresa_id = $2 ORDER BY criado_em DESC', [req.usuario.id, empresaId]);
        rows = resQuery.rows;
      } catch (err2) {
        rows = [];
      }
    }
    return res.json(rows);
  } catch (error) {
    console.error('[Erro GET /api/chamados]:', error.message);
    res.status(500).json({ error: 'Erro ao buscar chamados: ' + error.message });
  }
});

// ==========================================
// ROTA: Abertura de Chamado (Com Tenant ID)
// ==========================================
app.post('/api/chamados', autenticarToken, async (req, res) => {
  try {
    const { titulo, descricao, etiqueta_foto } = req.body;
    const empresaId = req.usuario.empresa_id || 'a0000000-0000-0000-0000-000000000001';

    if (!titulo || !descricao) {
      return res.status(400).json({ error: 'Título e descrição são obrigatórios.' });
    }

    try { await db.query('ALTER TABLE chamados ADD COLUMN IF NOT EXISTS etiqueta_foto TEXT;'); } catch (e) {}

    let result;
    try {
      result = await db.query(
        'INSERT INTO chamados (titulo, descricao, usuario_id, status, etiqueta_foto, empresa_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [titulo, descricao, req.usuario.id, 'ABERTO', etiqueta_foto || null, empresaId]
      );
    } catch (err1) {
      result = await db.query(
        'INSERT INTO chamados (titulo, descricao, usuarioid, status, etiqueta_foto, empresa_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [titulo, descricao, req.usuario.id, 'ABERTO', etiqueta_foto || null, empresaId]
      );
    }

    const chamadoId = result.rows[0].id;
    const userRes = await db.query('SELECT nome, telefone FROM usuarios WHERE id = $1', [req.usuario.id]);
    const cliente = userRes.rows[0];

    if (cliente && cliente.telefone) {
      const msgAbertura = `🖥️ *LL TECH INFO - SUPORTE TÉCNICO*
----------------------------------------
Olá, *${cliente.nome}*!
O seu chamado foi registrado com sucesso.
📌 *Chamado:* #${String(chamadoId).substring(0, 8)}
📝 *Assunto:* ${titulo}
🟢 *Status:* ABERTO`;
      enviarNotificacaoWhatsApp(cliente.telefone, msgAbertura);
    }

    if (DESTINO_TECNICO_WHATSAPP) {
      const msgAberturaTecnico = `🚨 *NOVO CHAMADO ABERTO*
----------------------------------------
Um novo chamado foi registado no sistema!
📌 *Chamado:* #${String(chamadoId).substring(0, 8)}
👤 *Cliente:* ${cliente ? cliente.nome : 'Desconhecido'}
📝 *Assunto:* ${titulo}
📄 *Descrição:* ${descricao}`;
      enviarNotificacaoWhatsApp(DESTINO_TECNICO_WHATSAPP, msgAberturaTecnico);
    }

    res.status(201).json({ mensagem: 'Chamado aberto com sucesso!', chamado: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao abrir chamado: ' + error.message });
  }
});

// ==========================================
// INTEGRACAO MERCADO PAGO: Gerar Pix
// ==========================================
app.post('/api/chamados/:id/pagar-pix', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { valor } = req.body;

    const chamadoRes = await db.query('SELECT * FROM chamados WHERE id = $1', [id]);
    if (chamadoRes.rows.length === 0) return res.status(404).json({ error: 'Chamado não encontrado.' });
    const chamado = chamadoRes.rows[0];

    const userRes = await db.query('SELECT nome, email, telefone, documento FROM usuarios WHERE id = $1', [req.usuario.id]);
    const cliente = userRes.rows[0] || {};

    let docLimpo = cliente.documento ? cliente.documento.replace(/\D/g, '') : '00000000000';
    if (docLimpo.length !== 11 && docLimpo.length !== 14) docLimpo = '12345678909';
    const tipoDoc = docLimpo.length === 14 ? 'CNPJ' : 'CPF';

    const payment = new Payment(mpClient);
    const body = {
      transaction_amount: Number(valor),
      description: `LL TECH INFO - Chamado #${String(chamado.id).substring(0, 8)}`,
      payment_method_id: 'pix',
      payer: {
        email: cliente.email || 'suporte@lltech.info',
        first_name: cliente.nome ? cliente.nome.split(' ')[0] : 'Cliente',
        last_name: cliente.nome ? cliente.nome.split(' ').slice(1).join(' ') || 'LL Tech' : 'LL Tech',
        identification: { type: tipoDoc, number: docLimpo }
      },
    };

    const response = await payment.create({ body });
    const qrCode = response?.point_of_interaction?.transaction_data?.qr_code;
    const qrCodeBase64 = response?.point_of_interaction?.transaction_data?.qr_code_base64;
    const pagamentoId = response?.id;

    try { await db.query('ALTER TABLE chamados ADD COLUMN IF NOT EXISTS qr_code TEXT;'); } catch (e) {}
    try { await db.query('ALTER TABLE chamados ADD COLUMN IF NOT EXISTS qr_code_base64 TEXT;'); } catch (e) {}

    await db.query(
      'UPDATE chamados SET status = $1, valor = $2, pagamento_id = $3, qr_code = $4, qr_code_base64 = $5 WHERE id = $6',
      ['AGUARDANDO PAGAMENTO', valor, String(pagamentoId), qrCode, qrCodeBase64, id]
    );

    if (cliente && cliente.telefone) {
      const msgPix = `🖥️ *LL TECH INFO - COBRANÇA PIX*
----------------------------------------
Cobrança gerada para o Chamado *#${String(chamado.id).substring(0, 8)}*.
💰 *Valor:* R$ ${Number(valor).toFixed(2)}
📌 *Pix Copia e Cola:*
${qrCode}`;
      enviarNotificacaoWhatsApp(cliente.telefone, msgPix);
    }

    return res.json({ mensagem: 'Cobrança Pix gerada!', pagamentoId, qrCode, qrCodeBase64 });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao gerar Pix: ' + error.message });
  }
});

// ==========================================
// INTEGRACAO MERCADO PAGO: Cartão Parcelado
// ==========================================
function mapearStatusMercadoPagoParaEnum(mpStatus) {
  switch (mpStatus) {
    case 'approved':
      return 'CONCLUIDO';
    case 'rejected':
    case 'cancelled':
      return 'FALHOU';
    case 'refunded':
    case 'charged_back':
      return 'ESTORNADO';
    case 'in_process':
    case 'pending':
    case 'authorized':
    default:
      return 'PENDENTE';
  }
}

// Webhook Mercado Pago
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const { action, type, data } = req.body || {};
    const paymentId = data?.id || req.query['data.id'] || req.query.id;

    if (paymentId && (type === 'payment' || action?.includes('payment'))) {
      const payment = new Payment(mpClient);
      const paymentInfo = await payment.get({ id: paymentId });
      const mpStatus = paymentInfo?.status;
      const statusEnum = mapearStatusMercadoPagoParaEnum(mpStatus);
      const statusDetalhe = paymentInfo?.status_detail || mpStatus || null;
      const transacaoId = String(paymentId);

      try {
        const pagUpdated = await db.query(
          `UPDATE public.pagamentos
           SET status = $1::status_pagamento,
               status_detalhe = COALESCE($2, status_detalhe),
               pago_em = CASE WHEN $1 = 'CONCLUIDO' THEN COALESCE(pago_em, NOW()) ELSE pago_em END
           WHERE transacao_id = $3
           RETURNING orcamento_id, empresa_id`,
          [statusEnum, statusDetalhe, transacaoId]
        );

        if (statusEnum === 'CONCLUIDO' && pagUpdated.rows.length > 0) {
          const { orcamento_id: orcId, empresa_id: empId } = pagUpdated.rows[0];
          if (orcId) {
            await db.query(
              `UPDATE public.orcamentos
               SET status = 'APROVADO'::status_orcamento
               WHERE id = $1 AND ($2::uuid IS NULL OR empresa_id = $2)`,
              [orcId, empId || null]
            );
          }
        }
      } catch (dbPagErr) {
        console.error('[Webhook Pagamentos/Orcamentos Sync]:', dbPagErr.message);
      }

      if (paymentInfo && mpStatus === 'approved') {
        const updateRes = await db.query(
          "UPDATE chamados SET status = 'EM ATENDIMENTO' WHERE pagamento_id = $1 AND status <> 'EM ATENDIMENTO' RETURNING *",
          [transacaoId]
        );

        if (updateRes.rows.length > 0) {
          const ch = updateRes.rows[0];
          const userId = ch.usuario_id || ch.usuarioid;
          const userRes = await db.query('SELECT nome, telefone FROM usuarios WHERE id = $1', [userId]);
          const cliente = userRes.rows[0];

          if (cliente && cliente.telefone) {
            enviarNotificacaoWhatsApp(cliente.telefone, `🖥️ *LL TECH INFO - PAGAMENTO APROVADO*
O pagamento do chamado *#${String(ch.id).substring(0, 8)}* foi confirmado! Status: EM ATENDIMENTO.`);
          }
        }
      }
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error('[Erro Webhook Mercado Pago]:', error.message);
    return res.status(200).send('OK');
  }
});

app.post('/api/pagamentos/cartao-parcelado', autenticarToken, async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id || 'a0000000-0000-0000-0000-000000000001';
    const {
      chamado_id,
      orcamento_id,
      valor,
      token,
      installments,
      payment_method_id,
      issuer_id,
      payer_email,
      identification_type,
      identification_number
    } = req.body;

    if (!token || !payment_method_id) {
      return res.status(400).json({ error: 'Token do cartão e meio de pagamento são obrigatórios.' });
    }

    const qtdParcelas = Number(installments) || 1;
    if (qtdParcelas < 1 || qtdParcelas > 24) {
      return res.status(400).json({ error: 'Quantidade de parcelas inválida.' });
    }

    let valorTotal = Number(valor) || 0;
    let orcamentoIdFinal = orcamento_id || null;
    let chamadoRef = null;

    if (chamado_id) {
      const chamadoRes = await db.query(
        'SELECT * FROM chamados WHERE id = $1 AND empresa_id = $2',
        [chamado_id, empresaId]
      );
      if (chamadoRes.rows.length === 0) {
        return res.status(404).json({ error: 'Chamado não encontrado para esta empresa.' });
      }
      chamadoRef = chamadoRes.rows[0];
      if (!valorTotal && chamadoRef.valor) {
        valorTotal = Number(chamadoRef.valor);
      }
    }

    if (orcamentoIdFinal) {
      const orcRes = await db.query(
        'SELECT id, valor_total, empresa_id FROM public.orcamentos WHERE id = $1 AND empresa_id = $2',
        [orcamentoIdFinal, empresaId]
      );
      if (orcRes.rows.length === 0) {
        return res.status(404).json({ error: 'Orçamento não encontrado para esta empresa.' });
      }
      if (!valorTotal && orcRes.rows[0].valor_total) {
        valorTotal = Number(orcRes.rows[0].valor_total);
      }
    }

    if (!valorTotal || valorTotal <= 0) {
      return res.status(400).json({ error: 'Valor total inválido para pagamento parcelado.' });
    }

    const maxParcelasPermitidas = valorTotal > 500 ? 3 : 2;
    if (qtdParcelas < 1 || qtdParcelas > maxParcelasPermitidas) {
      return res.status(400).json({
        error: `Quantidade de parcelas não permitida para o valor de R$ ${valorTotal.toFixed(2)}. Máximo permitido: ${maxParcelasPermitidas}x.`
      });
    }

    const userRes = await db.query(
      'SELECT nome, email, telefone, documento FROM usuarios WHERE id = $1',
      [req.usuario.id]
    );
    const cliente = userRes.rows[0] || {};

    let docLimpo = identification_number
      ? String(identification_number).replace(/\D/g, '')
      : (cliente.documento ? String(cliente.documento).replace(/\D/g, '') : '');
    const tipoDoc = identification_type || (docLimpo.length === 14 ? 'CNPJ' : 'CPF');

    const payment = new Payment(mpClient);
    const mpResponse = await payment.create({
      body: {
        transaction_amount: valorTotal,
        token,
        description: chamadoRef
          ? `LL TECH INFO - Chamado #${String(chamadoRef.id).substring(0, 8)} (${qtdParcelas}x)`
          : `LL TECH INFO - Pagamento (${qtdParcelas}x)`,
        installments: qtdParcelas,
        payment_method_id,
        issuer_id: issuer_id ? Number(issuer_id) : undefined,
        payer: {
          email: payer_email || cliente.email || 'suporte@lltech.info',
          identification: docLimpo ? { type: tipoDoc, number: docLimpo } : undefined
        },
        metadata: {
          empresa_id: empresaId,
          chamado_id: chamadoRef ? chamadoRef.id : null,
          orcamento_id: orcamentoIdFinal,
          parcelas: qtdParcelas
        }
      }
    });

    const mpStatus = mpResponse.status;
    const statusEnum = mapearStatusMercadoPagoParaEnum(mpStatus);
    const statusDetalhe = mpResponse.status_detail || mpStatus;
    const valorParcela = Number((valorTotal / qtdParcelas).toFixed(2));
    const transacaoId = String(mpResponse.id);
    const pagoEm = statusEnum === 'CONCLUIDO' ? new Date() : null;

    let pagamentoSalvo = null;
    if (orcamentoIdFinal) {
      const insertPag = await db.query(
        `INSERT INTO public.pagamentos (
          orcamento_id,
          metodo,
          status,
          transacao_id,
          pago_em,
          empresa_id,
          parcelas,
          valor_parcela,
          valor_total,
          status_detalhe
        ) VALUES ($1, $2, $3::status_pagamento, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          orcamentoIdFinal,
          'CREDIT_CARD',
          statusEnum,
          transacaoId,
          pagoEm,
          empresaId,
          qtdParcelas,
          valorParcela,
          valorTotal,
          statusDetalhe
        ]
      );
      pagamentoSalvo = insertPag.rows[0];
    }

    if (statusEnum === 'CONCLUIDO') {
      if (orcamentoIdFinal) {
        await db.query(
          `UPDATE public.orcamentos
           SET status = 'APROVADO'::status_orcamento
           WHERE id = $1 AND empresa_id = $2`,
          [orcamentoIdFinal, empresaId]
        );
      }

      if (chamadoRef) {
        await db.query(
          `UPDATE chamados
           SET status = 'EM ATENDIMENTO', valor = $1, pagamento_id = $2
           WHERE id = $3`,
          [valorTotal, transacaoId, chamadoRef.id]
        );

        if (cliente && cliente.telefone) {
          enviarNotificacaoWhatsApp(
            cliente.telefone,
            `🖥️ *LL TECH INFO - PAGAMENTO APROVADO*\nO pagamento parcelado (${qtdParcelas}x de R$ ${valorParcela.toFixed(2)}) do chamado *#${String(chamadoRef.id).substring(0, 8)}* foi confirmado! Status: EM ATENDIMENTO.`
          );
        }
      }
    } else if (chamadoRef) {
      await db.query(
        `UPDATE chamados
         SET status = 'AGUARDANDO PAGAMENTO', valor = $1, pagamento_id = $2
         WHERE id = $3`,
        [valorTotal, transacaoId, chamadoRef.id]
      );
    }

    return res.json({
      mensagem: statusEnum === 'CONCLUIDO'
        ? 'Pagamento no cartão aprovado!'
        : 'Pagamento processado com status pendente/em análise.',
      pagamentoId: transacaoId,
      statusGateway: mpStatus,
      statusEnum,
      statusDetalhe,
      parcelas: qtdParcelas,
      valorParcela,
      pagamento: pagamentoSalvo
    });
  } catch (error) {
    const mpCause = error?.cause?.[0]?.description || error?.cause?.[0]?.code || '';
    const detalheErro = mpCause ? `${error.message} (${mpCause})` : error.message;
    console.error('[Erro POST /api/pagamentos/cartao-parcelado]:', detalheErro, error?.cause || '');
    return res.status(error?.status && error.status >= 400 && error.status < 500 ? error.status : 500).json({
      error: 'Erro ao processar pagamento no cartão: ' + detalheErro
    });
  }
});

app.get('/api/chamados/:id/verificar-pagamento', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const chamadoRes = await db.query('SELECT * FROM chamados WHERE id = $1', [id]);
    if (chamadoRes.rows.length === 0) return res.status(404).json({ error: 'Chamado não encontrado.' });
    const chamado = chamadoRes.rows[0];

    if (chamado.pagamento_id && chamado.status === 'AGUARDANDO PAGAMENTO') {
      const payment = new Payment(mpClient);
      const paymentInfo = await payment.get({ id: chamado.pagamento_id });
      if (paymentInfo && paymentInfo.status === 'approved') {
        await db.query("UPDATE chamados SET status = 'EM ATENDIMENTO' WHERE id = $1", [id]);
        
        try {
          const userId = chamado.usuario_id || chamado.usuarioid;
          const userRes = await db.query('SELECT nome, telefone FROM usuarios WHERE id = $1', [userId]);
          const cliente = userRes.rows[0];

          if (cliente && cliente.telefone) {
            await enviarNotificacaoWhatsApp(cliente.telefone, `🖥️ *LL TECH INFO - PAGAMENTO APROVADO*
O pagamento do chamado *#${String(chamado.id).substring(0, 8)}* foi confirmado! Status: EM ATENDIMENTO.`);
          }
        } catch (whatsappErr) {
          console.error('[Erro WhatsApp Verificação]:', whatsappErr.message);
        }

        return res.json({ status: 'EM ATENDIMENTO', pago: true });
      }
    }
    return res.json({ status: chamado.status, pago: chamado.status !== 'AGUARDANDO PAGAMENTO' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ==========================================
// LÓGICA CENTRALIZADA DE ATUALIZAÇÃO
// ==========================================
async function processarAtualizacaoChamado(req, res) {
  try {
    const { id } = req.params;
    const { status, valor, titulo, descricao } = req.body;
    
    const tipoUsuario = String(req.usuario?.tipo || '').toUpperCase();
    const empresaId = req.usuario.empresa_id || 'a0000000-0000-0000-0000-000000000001';

    const chamadoAtualRes = await db.query('SELECT * FROM chamados WHERE id = $1', [id]);
    if (chamadoAtualRes.rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado.' });
    }
    const chamadoAtual = chamadoAtualRes.rows[0];

    if (chamadoAtual.empresa_id && chamadoAtual.empresa_id !== empresaId) {
      return res.status(403).json({ error: 'Acesso negado. O chamado pertence a outra organização.' });
    }

    if (tipoUsuario === 'CLIENTE') {
      const donoId = chamadoAtual.usuario_id || chamadoAtual.usuarioid;
      if (donoId !== req.usuario.id) {
        return res.status(403).json({ error: 'Acesso negado.' });
      }
      
      const statusAtualUpper = String(chamadoAtual.status || '').toUpperCase();
      if (statusAtualUpper !== 'ABERTO' && statusAtualUpper !== 'AGUARDANDO PAGAMENTO' && statusAtualUpper !== 'AGUARDANDO_PAGAMENTO') {
        return res.status(400).json({ error: 'Este chamado já está em atendimento ou concluído e não pode ser editado.' });
      }

      if (status !== undefined || valor !== undefined) {
        return res.status(403).json({ error: 'Clientes não podem alterar o status ou valor do chamado.' });
      }
    }

    if (String(chamadoAtual.status).toUpperCase() === 'CONCLUÍDO' || String(chamadoAtual.status).toUpperCase() === 'CONCLUIDO') {
      return res.status(400).json({ error: 'Este chamado já está concluído e não pode ser editado.' });
    }

    try { await db.query('ALTER TABLE chamados ADD COLUMN IF NOT EXISTS valor NUMERIC(10,2) DEFAULT 0.00;'); } catch (e) {}

    let campos = [];
    let params = [];
    let idx = 1;

    if (tipoUsuario === 'CLIENTE') {
      if (titulo !== undefined) { campos.push(`titulo = $${idx++}`); params.push(titulo); }
      if (descricao !== undefined) { campos.push(`descricao = $${idx++}`); params.push(descricao); }
      if (campos.length === 0) {
        return res.status(400).json({ error: 'Nenhum campo válido fornecido para atualização.' });
      }
    } else {
      if (status !== undefined) { campos.push(`status = $${idx++}`); params.push(status); }
      if (valor !== undefined) { campos.push(`valor = $${idx++}`); params.push(valor); }
      if (titulo !== undefined) { campos.push(`titulo = $${idx++}`); params.push(titulo); }
      if (descricao !== undefined) { campos.push(`descricao = $${idx++}`); params.push(descricao); }
    }

    params.push(id);
    const query = `UPDATE chamados SET ${campos.join(', ')} WHERE id = $${idx} RETURNING *`;

    const result = await db.query(query, params);
    const chamadoAtualizado = result.rows[0];

    if (status) {
      const statusUpper = String(status).toUpperCase().trim();
      const userId = chamadoAtualizado.usuario_id || chamadoAtualizado.usuarioid;
      const userRes = await db.query('SELECT nome, telefone FROM usuarios WHERE id = $1', [userId]);
      const cliente = userRes.rows[0];

      if (cliente && cliente.telefone) {
        let complementoStatus = '';
        if (statusUpper === 'AGUARDANDO PAGAMENTO' || statusUpper === 'AGUARDANDO_PAGAMENTO') {
          complementoStatus = '\n\n💳 Acesse o painel e escolha a forma de pagamento.';
        } else if (statusUpper === 'CONCLUIDO' || statusUpper === 'CONCLUÍDO') {
          complementoStatus = '\n\n📦 O seu equipamento já pode ser retirado.';
        }

        const msgAtualizacao = `🖥️ *LL TECH INFO - ATUALIZAÇÃO DE CHAMADO*
----------------------------------------
Olá, *${cliente.nome}*!
O seu chamado *#${String(chamadoAtualizado.id).substring(0, 8)}* foi atualizado.
📌 *Novo Status:* ${statusUpper}${complementoStatus}`;
        
        enviarNotificacaoWhatsApp(cliente.telefone, msgAtualizacao);
      }
    }

    return res.json({ mensagem: 'Chamado atualizado com sucesso!', chamado: chamadoAtualizado });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// REGISTO DE ROTAS DE ATUALIZAÇÃO
app.patch('/api/chamados/:id', autenticarToken, processarAtualizacaoChamado);
app.put('/api/chamados/:id', autenticarToken, processarAtualizacaoChamado);
app.post('/api/chamados/:id', autenticarToken, processarAtualizacaoChamado);

app.patch('/api/chamados/:id/editar', autenticarToken, processarAtualizacaoChamado);
app.put('/api/chamados/:id/editar', autenticarToken, processarAtualizacaoChamado);
app.post('/api/chamados/:id/editar', autenticarToken, processarAtualizacaoChamado);

app.patch('/chamados/:id', autenticarToken, processarAtualizacaoChamado);
app.put('/chamados/:id', autenticarToken, processarAtualizacaoChamado);
app.post('/chamados/:id', autenticarToken, processarAtualizacaoChamado);

// ==========================================
// ROTA: Atualização Administrativa de Senha
// ==========================================
app.put('/api/admin/atualizar-senha', autenticarToken, async (req, res) => {
    const { email, novaSenha } = req.body;

    if (!email || !novaSenha) {
        return res.status(400).json({ error: 'E-mail e nova senha são obrigatórios.' });
    }

    try {
        const tipoUsuario = String(req.usuario?.tipo || '').toUpperCase();
        if (tipoUsuario === 'CLIENTE') {
            return res.status(403).json({ error: 'Acesso negado. Apenas técnicos podem atualizar senhas administrativamente.' });
        }

        const hash = await bcrypt.hash(novaSenha, 10);

        const resultado = await db.query(
            'UPDATE usuarios SET senha = $1, senha_hash = $1 WHERE email = $2 RETURNING id, nome, email',
            [hash, email]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Utilizador não encontrado com este e-mail.' });
        }

        res.json({ 
            success: true, 
            message: `Senha do utilizador ${resultado.rows[0].nome} atualizada com sucesso!` 
        });
    } catch (err) {
        console.error('[Erro ao atualizar senha]:', err);
        res.status(500).json({ error: 'Erro interno ao atualizar a senha: ' + err.message });
    }
});

// ==========================================
// ROTA DEFINITIVA: ALTERAR SENHA E PERFIL
// ==========================================
app.put('/api/usuarios/me/senha', autenticarToken, async (req, res) => {
    try {
        const { senhaAtual, novaSenha, telefone } = req.body;
        const usuarioId = req.usuario.id;

        if (!novaSenha || novaSenha.length < 6) {
            return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres.' });
        }

        const userQuery = await db.query('SELECT senha, senha_hash FROM usuarios WHERE id = $1', [usuarioId]);
        if (userQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Utilizador não encontrado.' });
        }

        const usuario = userQuery.rows[0];
        const hashAtual = usuario.senha_hash || usuario.senha;

        const senhaValida = await bcrypt.compare(senhaAtual, hashAtual);
        if (!senhaValida) {
            return res.status(401).json({ error: 'A senha atual está incorreta.' });
        }

        const novoHash = await bcrypt.hash(novaSenha, 10);
        await db.query(
            'UPDATE usuarios SET senha = $1, senha_hash = $1, telefone = COALESCE($2, telefone) WHERE id = $3',
            [novoHash, telefone, usuarioId]
        );

        res.json({ success: true, message: 'Perfil e senha atualizados com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// SALVAGUARDA DE ERROS JSON
// ==========================================
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `Endpoint de API não encontrado: ${req.method} ${req.originalUrl}` });
});

// ==========================================
// INICIALIZAÇÃO ÚNICA
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[LL TECH INFO Backend Live] Servidor rodando na porta ${PORT}`);
});