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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

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
// ROTA: Criar Chamado com Suporte a Foto da Etiqueta
// ==========================================
app.post('/api/chamados', autenticarToken, async (req, res) => {
  try {
    const { titulo, descricao, etiqueta_foto } = req.body;
    if (!titulo || !descricao) {
      return res.status(400).json({ error: 'Título e descrição são obrigatórios.' });
    }

    // Garante que a coluna etiqueta_foto existe na tabela de chamados
    try {
      await db.query('ALTER TABLE chamados ADD COLUMN IF NOT EXISTS etiqueta_foto TEXT;');
    } catch (e) {
      // Ignora caso já
