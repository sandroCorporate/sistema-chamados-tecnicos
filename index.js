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

// Token real do Mercado Pago integrado
const MP_TOKEN_REAL = 'APP_USR-5595843191696827-101213-f5e5271648f3f70353dbc57f81016599-332217735';

// Inicializa o cliente do Mercado Pago
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || MP_TOKEN_REAL,
});

app.use(express.json());

// Servir ficheiros estáticos (para disponibilizar o logo.png)
app.use(express.static('public'));

// ==========================================
// FUNÇÃO AUXILIAR: Envio de WhatsApp (LL TECH INFO - Padrão 5S)
// ==========================================
async function enviarNotificacaoWhatsApp(telefone, mensagem) {
  const waUrl = 'https://api.z-api.io/instances/3FA96A6E1C7E826EA6682AB027F8477F/token/B2F6CE0E3D44D70B123969D9/send-text';
  const accountClientToken = 'Fdb54180c68fc4457802387d62cb97fb5S';

  if (!telefone || telefone.trim() === '') {
    console.log('[WhatsApp Skipped] Telefone não configurado.');
    return;
  }

  let numApenasDigitos = telefone.replace(/\D/g, '');
  if (numApenasDigitos.length === 10 || numApenasDigitos.length === 11) {
    numApenasDigitos = '55' + numApenasDigitos;
  }

  try {
    const response = await fetch(waUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': accountClientToken,
      },
      body: JSON.stringify({
        phone: numApenasDigitos,
        message: mensagem,
      }),
    });

    const data = await response.json();
    console.log(`[WhatsApp Sent] Resposta Z-API para ${numApenasDigitos}:`, data);
  } catch (error) {
    console.error(
      '[WhatsApp Error] Falha ao enviar notificação (ignorado):',
      error.message
    );
  }
}

// ==========================================
// MIDDLEWARE: Autenticação JWT
// ==========================================
function autenticarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

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
// ROTA: Frontend Principal (SPA)
// ==========================================
app.get('/', (req, res) => {
  res.sendFile(process.cwd() + '/index.html');
});

// ==========================================
// ROTA: Cadastro Público de Clientes (Corrigida)
// ==========================================
app.post('/api/registro', async (req, res) => {
  const { nome, email, telefone, documento, senha } = req.body;

  if (!nome || !email || !telefone || !documento || !senha) {
    return res.status(400).json({ 
      error: 'Preencha todos os campos obrigatórios: Nome, E-mail, WhatsApp, CPF/CNPJ e Senha.' 
    });
  }

  let telLimpo = telefone.replace(/\D/g, '');
  if (telLimpo.length < 10) {
    return res.status(400).json({ error: 'Informe um número de WhatsApp válido com DDD.' });
  }

  try {
    const hashSenha = await bcrypt.hash(senha, 10);

    // Insere preenchendo tanto 'senha' quanto 'senha_hash' para satisfazer qualquer restrição da base de dados
    const query = `
      INSERT INTO usuarios (nome, email, telefone, documento, senha, senha_hash, tipo)
      VALUES ($1, $2, $3, $4, $5, $5, 'CLIENTE')
      RETURNING id, nome, email, telefone, tipo;
    `;
    
    const result = await db.query(query, [nome, email, telLimpo, documento, hashSenha]);
    return res.status(201).json({ message: 'Cliente cadastrado com sucesso!', usuario: result.rows[0] });

  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'E-mail ou CPF/CNPJ já cadastrado no sistema.' });
    }
    res.status(500).json({ error: 'Erro interno ao registrar cliente: ' + error.message });
  }
});

// ==========================================
// ROTA: Login
// ==========================================
app.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const { rows } = await db.query('SELECT * FROM usuarios WHERE email = \$1', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const usuario = rows[0];
    const hashGravado = usuario.senha || usuario.senha_hash;
    if (!hashGravado) {
      return res.status(500).json({ error: 'Hash de senha não encontrado.' });
    }

    const senhaValida = await bcrypt.compare(senha, hashGravado);
    if (!senhaValida) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const tipo = usuario.tipo || usuario.perfil || 'CLIENTE';
    const payload = { id: usuario.id, email: usuario.email, tipo };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        tipo,
        telefone: usuario.telefone,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao realizar login.' });
  }
});

// ==========================================
// ROTA: Listar Chamados
// ==========================================
app.get('/api/chamados', autenticarToken, async (req, res) => {
  try {
    if (req.usuario.tipo !== 'CLIENTE') {
      const { rows } = await db.query('SELECT * FROM chamados ORDER BY criado_em DESC');
      return res.json(rows);
    }

    let rows;
    try {
      const resQuery = await db.query('SELECT * FROM chamados WHERE usuario_id = \$1 ORDER BY criado_em DESC', [req.usuario.id]);
      rows = resQuery.rows;
    } catch (err1) {
      try {
        const resQuery = await db.query('SELECT * FROM chamados WHERE cliente_id = \$1 ORDER BY criado_em DESC', [req.usuario.id]);
        rows = resQuery.rows;
      } catch (err2) {
        const resQuery = await db.query('SELECT * FROM chamados WHERE usuarioid = \$1 ORDER BY criado_em DESC', [req.usuario.id]);
        rows = resQuery.rows;
      }
    }

    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar chamados:', error);
    res.status(500).json({ error: 'Erro ao buscar chamados.' });
  }
});

// ==========================================
// ROTA: Criar Chamado
// ==========================================
app.post('/api/chamados', autenticarToken, async (req, res) => {
  try {
    const { titulo, descricao } = req.body;
    if (!titulo || !descricao) {
      return res.status(400).json({ error: 'Título e descrição são obrigatórios.' });
    }

    let result;
    try {
      result = await db.query(
        'INSERT INTO chamados (titulo, descricao, usuario_id, status) VALUES (\$1, \$2, \$3, \$4) RETURNING *',
        [titulo, descricao, req.usuario.id, 'ABERTO']
      );
    } catch (err1) {
      result = await db.query(
        'INSERT INTO chamados (titulo, descricao, cliente_id, status) VALUES (\$1, \$2, \$3, \$4) RETURNING *',
        [titulo, descricao, req.usuario.id, 'ABERTO']
      );
    }

    const chamadoId = result.rows[0].id;

    // Disparar Notificação WhatsApp (Padrão Executivo 5S)
    const userRes = await db.query('SELECT nome, telefone FROM usuarios WHERE id = \$1', [req.usuario.id]);
    const cliente = userRes.rows[0];
    if (cliente && cliente.telefone) {
      const msgAbertura = `🖥️ *LL TECH INFO - SUPORTE TÉCNICO*
----------------------------------------
Olá, *${cliente.nome}*!

O seu chamado foi registrado com sucesso em nosso sistema.

📌 *Chamado:* #${chamadoId.substring(0, 8)}
📝 *Assunto:* ${titulo}
🟢 *Status:* ABERTO (Aguardando análise da equipa)

Acompanhe a evolução do seu atendimento pelo portal.`;

      enviarNotificacaoWhatsApp(cliente.telefone, msgAbertura);
    }

    res.status(201).json({
      mensagem: 'Chamado aberto com sucesso!',
      chamado: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao abrir chamado.' });
  }
});

// ==========================================
// ROTA: Gerar Pagamento Pix (Suporte a R\$ 0,03)
// ==========================================
app.post('/api/chamados/:id/pagar-pix', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { valor } = req.body;

    if (!valor || valor <= 0) {
      return res.status(400).json({ error: 'Valor inválido para o pagamento.' });
    }

    const chamadoRes = await db.query('SELECT * FROM chamados WHERE id = \$1', [id]);
    if (chamadoRes.rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado.' });
    }
    const chamado = chamadoRes.rows[0];

    // Busca os dados do usuário/cliente logado (incluindo documento e telefone)
    const userRes = await db.query('SELECT nome, email, telefone, documento FROM usuarios WHERE id = \$1', [req.usuario.id]);
    const cliente = userRes.rows[0] || {};

    // Limpa o documento para enviar apenas números (exigido pelo Mercado Pago)
    let docLimpo = cliente.documento ? cliente.documento.replace(/\D/g, '') : '00000000000';
    if (docLimpo.length !== 11 && docLimpo.length !== 14) {
      docLimpo = '12345678909'; // Fallback padrão caso o documento esteja incompleto
    }
    const tipoDoc = docLimpo.length === 14 ? 'CNPJ' : 'CPF';

    let pagamentoId, qrCode, qrCodeBase64;

    try {
      const payment = new Payment(mpClient);
      const body = {
        transaction_amount: Number(valor),
        description: `LL TECH INFO - Chamado #${chamado.id.substring(0, 8)}`,
        payment_method_id: 'pix',
        payer: {
          email: cliente.email || req.usuario.email || 'suporte@lltech.info',
          first_name: cliente.nome ? cliente.nome.split(' ')[0] : 'Cliente',
          last_name: cliente.nome ? cliente.nome.split(' ').slice(1).join(' ') || 'LL Tech' : 'LL Tech',
          identification: {
            type: tipoDoc,
            number: docLimpo
          }
        },
      };

      const response = await payment.create({ body });
      qrCode = response?.point_of_interaction?.transaction_data?.qr_code;
      qrCodeBase64 = response?.point_of_interaction?.transaction_data?.qr_code_base64;
      pagamentoId = response?.id;

      if (!qrCode) {
        throw new Error('A API do Mercado Pago não retornou o código Pix.');
      }
    } catch (apiErr) {
      console.error('[Mercado Pago Erro Real]:', apiErr.message);
      return res.status(500).json({ error: 'Erro ao gerar Pix no Mercado Pago: ' + apiErr.message });
    }

    await db.query(
      'UPDATE chamados SET status = \$1, valor = \$2, pagamento_id = \$3 WHERE id = \$4',
      ['AGUARDANDO PAGAMENTO', valor, String(pagamentoId), id]
    );

    if (cliente && cliente.telefone) {
      const msgPix = `🖥️ *LL TECH INFO - COBRANÇA PIX*
----------------------------------------
Olá, *${cliente.nome}*!

Cobrança gerada para o Chamado *#${chamado.id.substring(0, 8)}*.
💰 *Valor:* R$ ${Number(valor).toFixed(2)}

📌 *Código Pix Copia e Cola:*
${qrCode}

Efetue o pagamento para darmos seguimento ao atendimento.`;
      enviarNotificacaoWhatsApp(cliente.telefone, msgPix);
    }

    return res.json({
      mensagem: 'Cobrança Pix gerada com sucesso!',
      pagamentoId,
      qrCode,
      qrCodeBase64,
    });
  } catch (error) {
    console.error('Erro detalhado no pagamento Pix:', error);
    return res.status(500).json({ error: 'Erro ao gerar pagamento Pix: ' + error.message });
  }
});

// ==========================================
// ROTA: Webhook Mercado Pago
// ==========================================
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const { action, data } = req.body;

    if (action === 'payment.created' || action === 'payment.updated') {
      const paymentId = data.id;
      const payment = new Payment(mpClient);
      const paymentInfo = await payment.get({ id: paymentId });

      if (paymentInfo.status === 'approved') {
        const updateRes = await db.query(
          "UPDATE chamados SET status = 'EM ATENDIMENTO' WHERE pagamento_id = \$1 RETURNING *",
          [String(paymentId)]
        );

        if (updateRes.rows.length > 0) {
          const ch = updateRes.rows[0];
          const userId = ch.usuario_id || ch.cliente_id || ch.usuarioid;
          if (userId) {
            const userRes = await db.query('SELECT nome, telefone FROM usuarios WHERE id = \$1', [userId]);
            const cliente = userRes.rows[0];
            if (cliente && cliente.telefone) {
              const msgAprovado = `🖥️ *LL TECH INFO - PAGAMENTO CONFIRMADO*
----------------------------------------
Olá, *${cliente.nome}*!

O pagamento do chamado *#${ch.id.substring(0, 8)}* foi aprovado com sucesso.
🟢 *Status Atual:* EM ATENDIMENTO

A nossa equipa técnica já está a atuar no seu caso.`;
              enviarNotificacaoWhatsApp(cliente.telefone, msgAprovado);
            }
          }
        }
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no webhook do Mercado Pago:', error);
    res.status(500).json({ error: 'Erro ao processar webhook.' });
  }
});

// ==========================================
// ROTA: Atualizar Chamado (Status e Valor - Técnico)
// ==========================================
app.patch('/api/chamados/:id', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, valor } = req.body;

    if (!req.usuario || req.usuario.tipo.toUpperCase() !== 'TECNICO') {
      return res.status(403).json({ error: 'Acesso negado. Apenas técnicos podem atualizar chamados.' });
    }

    // Garante que a coluna valor existe na tabela
    try {
      await db.query('ALTER TABLE chamados ADD COLUMN IF NOT EXISTS valor NUMERIC(10,2) DEFAULT 0.00;');
    } catch (e) {
      // Ignora se já existir
    }

    // Atualiza status e/ou valor conforme enviado no pedido
    let query, params;
    if (valor !== undefined && status !== undefined) {
      query = 'UPDATE chamados SET status = \$1, valor = \$2 WHERE id = \$3 RETURNING *';
      params = [status, valor, id];
    } else if (status !== undefined) {
      query = 'UPDATE chamados SET status = \$1 WHERE id = \$2 RETURNING *';
      params = [status, id];
    } else if (valor !== undefined) {
      query = 'UPDATE chamados SET valor = \$1 WHERE id = \$2 RETURNING *';
      params = [valor, id];
    } else {
      return res.status(400).json({ error: 'Nenhum dado fornecido para atualização.' });
    }

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado.' });
    }

    const chamado = result.rows[0];
    const clienteId = chamado.usuario_id || chamado.cliente_id || chamado.usuarioid;

    // Dispara notificação via WhatsApp para o cliente
    if (clienteId) {
      try {
        const userRes = await db.query('SELECT telefone, nome FROM usuarios WHERE id = \$1', [clienteId]);
        const cliente = userRes.rows[0];
        
        if (cliente && cliente.telefone) {
          const idCurto = String(chamado.id).substring(0, 8);
          const valorFormatado = chamado.valor ? parseFloat(chamado.valor).toFixed(2) : '0.00';
          
          let linhaValor = '';
          if (chamado.valor) {
            linhaValor = '💰 *Valor do Serviço:* R$ ' + valorFormatado;
          }

          const msgAtualizacao = `🖥️ *LL TECH INFO - ATUALIZAÇÃO DE CHAMADO*
----------------------------------------
Olá, *${cliente.nome}*!

O seu chamado *#${idCurto}* foi atualizado pela nossa equipa técnica.

📌 *Assunto:* ${chamado.titulo}
🔄 *Novo Status:* ${String(chamado.status).toUpperCase()}
${linhaValor}

Aceda ao portal para efetuar o pagamento via Pix e prosseguir com o atendimento.`;

          await enviarNotificacaoWhatsApp(cliente.telefone, msgAtualizacao);
        }
      } catch (waErr) {
        console.error('[WhatsApp Aviso] Erro ao enviar notificação de status:', waErr.message);
      }
    }

    res.json({ mensagem: 'Chamado atualizado com sucesso!', chamado });
  } catch (error) {
    console.error('Erro ao atualizar chamado:', error);
    res.status(500).json({ error: 'Erro interno ao atualizar chamado: ' + error.message });
  }
});

// ==========================================
// ROTA: Atualizar Valor do Chamado (Técnico)
// ==========================================
app.patch('/api/chamados/:id/valor', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { valor } = req.body;

    if (req.usuario.tipo === 'CLIENTE') {
      return res.status(403).json({ error: 'Apenas técnicos podem alterar valores.' });
    }

    const result = await db.query(
      'UPDATE chamados SET valor = \$1 WHERE id = \$2 RETURNING *',
      [valor, id]
    );

    res.json({ mensagem: 'Valor atualizado!', chamado: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar valor.' });
  }
});

// ==========================================
// ROTA: Editar Chamado
// ==========================================
app.patch('/api/chamados/:id/editar', autenticarToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { titulo, descricao } = req.body;

    const { rows } = await db.query('SELECT * FROM chamados WHERE id = \$1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Chamado não encontrado.' });
    }

    const chamado = rows[0];
    if (chamado.status !== 'ABERTO') {
      return res.status(400).json({ error: 'Apenas chamados ABERTOS podem ser editados.' });
    }

    const result = await db.query(
      'UPDATE chamados SET titulo = \$1, descricao = \$2 WHERE id = \$3 RETURNING *',
      [titulo, descricao, id]
    );

    res.json({
      mensagem: 'Chamado atualizado com sucesso!',
      chamado: result.rows[0],
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao editar chamado.' });
  }
});

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR
// ==========================================
app.listen(PORT, () => {
  console.log(`Servidor LL TECH INFO rodando na porta ${PORT}`);
});
