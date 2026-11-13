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
    const query = `
      INSERT INTO usuarios (nome, email, telefone, documento, senha, senha_hash, tipo)
      VALUES ($1, $2, $3, $4, $5, $5, 'CLIENTE')
      RETURNING id, nome, email, telefone, tipo;
    `;
    const result = await db.query(query, [nome, email, telLimpo, documento, hashSenha]);
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
    
    // Payload JWT agora inclui o empresa_id para contexto multi-tenant
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
      // Query blindada para técnicos filtrada estritamente pelo tenant (empresa_id)
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
        // Fallback caso utilize usuarioid
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

    // Para Clientes (filtrado pelo utilizador e pela empresa)
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

    await db.query(
      'UPDATE chamados SET status = $1, valor = $2, pagamento_id = $3 WHERE id = $4',
      ['AGUARDANDO PAGAMENTO', valor, String(pagamentoId), id]
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

// Webhook Mercado Pago
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const { action, type, data } = req.body;
    const paymentId = data?.id || req.query['data.id'] || req.query.id;

    if (paymentId && (type === 'payment' || action?.includes('payment'))) {
      const payment = new Payment(mpClient);
      const paymentInfo = await payment.get({ id: paymentId });

      if (paymentInfo && paymentInfo.status === 'approved') {
        const updateRes = await db.query(
          "UPDATE chamados SET status = 'EM ATENDIMENTO' WHERE pagamento_id = $1 RETURNING *",
          [String(paymentId)]
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
    return res.status(200).send('OK');
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
        
        // Dispara o WhatsApp de forma segura e blindada
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

    const chamadoAtualRes = await db.query('SELECT * FROM chamados WHERE id = $1', [id]);
    if (chamadoAtualRes.rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado.' });
    }
    const chamadoAtual = chamadoAtualRes.rows[0];

    if (tipoUsuario === 'CLIENTE') {
      const donoId = chamadoAtual.usuario_id || chamadoAtual.usuarioid;
      if (donoId !== req.usuario.id) {
        return res.status(403).json({ error: 'Acesso negado.' });
      }
      
      if (String(chamadoAtual.status).toUpperCase() !== 'ABERTO') {
        return res.status(400).json({ error: 'Este chamado já não está aberto e não pode ser editado.' });
      }

      if (status !== undefined || valor !== undefined) {
        return res.status(403).json({ error: 'Clientes não podem alterar o status ou valor do chamado.' });
      }
    }

    if (String(chamadoAtual.status).toUpperCase() === 'CONCLUÍDO') {
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
      const statusUpper = String(status).toUpperCase();
      const userId = chamadoAtualizado.usuario_id || chamadoAtualizado.usuarioid;
      const userRes = await db.query('SELECT nome, telefone FROM usuarios WHERE id = $1', [userId]);
      const cliente = userRes.rows[0];

      if (cliente && cliente.telefone) {
        const msgAtualizacao = `🖥️ *LL TECH INFO - ATUALIZAÇÃO DE CHAMADO*
----------------------------------------
Olá, *${cliente.nome}*!
O seu chamado *#${String(chamadoAtualizado.id).substring(0, 8)}* foi atualizado.
📌 *Novo Status:* ${statusUpper}`;
        
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
// ROTA: Atualização Administrativa de Senha (Mantém Histórico e Chamados)
// ==========================================
app.put('/api/admin/atualizar-senha', autenticarToken, async (req, res) => {
    const { email, novaSenha } = req.body;

    if (!email || !novaSenha) {
        return res.status(400).json({ error: 'E-mail e nova senha são obrigatórios.' });
    }

    try {
        // Valida se quem está a chamar é técnico/admin (opcional mas recomendado)
        const tipoUsuario = String(req.usuario?.tipo || '').toUpperCase();
        if (tipoUsuario === 'CLIENTE') {
            return res.status(403).json({ error: 'Acesso negado. Apenas técnicos podem atualizar senhas administrativamente.' });
        }

        // Gera o hash seguro com Bcrypt (custo 10) garantindo compatibilidade com o login
        const hash = await bcrypt.hash(novaSenha, 10);

        // Atualiza apenas a senha preservando o ID e todo o histórico de chamados atrelados
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

/*
// ==========================================
// ROTA TEMPORÁRIA DE RESET DIRETO (Apagar após usar)
// ==========================================
app.get('/api/admin/forcar-senha', async (req, res) => {
    try {
        const hash = await bcrypt.hash('Trug@2010', 10);
        const resultado = await db.query(
            'UPDATE usuarios SET senha = $1, senha_hash = $1 WHERE email = $2 RETURNING id, nome, email',
            [hash, 'sandro@tech.com']
        );
        if (resultado.rows.length === 0) {
            return res.json({ error: 'Utilizador não encontrado.' });
        }
        res.json({ success: true, message: `Senha redefinida com sucesso para ${resultado.rows[0].nome}!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
*/

// ==========================================
// ROTA DEFINITIVA: ALTERAR SENHA E PERFIL
// ==========================================
app.put('/api/usuarios/me/senha', autenticarToken, async (req, res) => {
    try {
        const { senhaAtual, novaSenha, telefone } = req.body;
        const usuarioId = req.usuario.id; // Vem do token JWT

        if (!novaSenha || novaSenha.length < 6) {
            return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres.' });
        }

        // 1. Busca os dados atuais do utilizador para validar a senha antiga
        const userQuery = await db.query('SELECT senha, senha_hash FROM usuarios WHERE id = $1', [usuarioId]);
        if (userQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Utilizador não encontrado.' });
        }

        const usuario = userQuery.rows[0];
        const hashAtual = usuario.senha_hash || usuario.senha;

        // 2. Verifica se a senha atual informada no formulário bate com o hash da base de dados
        const senhaValida = await bcrypt.compare(senhaAtual, hashAtual);
        if (!senhaValida) {
            return res.status(401).json({ error: 'A senha atual está incorreta.' });
        }

        // 3. Gera o novo hash Bcrypt e atualiza o registo
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
