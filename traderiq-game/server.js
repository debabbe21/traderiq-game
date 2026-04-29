const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ====== GAME CONFIG ======
const ADMIN_PASSWORD = '2013';
const MAX_ROUNDS = 20;
const MAX_TEAM_MEMBERS = 4;
const STOCKS = {
  A: { name: 'Aktie A', beta: 10 },
  B: { name: 'Aktie B', beta: 6 },
  C: { name: 'Aktie C', beta: 3 }
};
const DICE_MULTIPLIERS = [-3, -2, -1, 1, 2, 3];

// ====== GAME STATE (server-side, single source of truth) ======
let gameState = createFreshState();

function createFreshState() {
  return {
    currentRound: 0,
    maxRounds: MAX_ROUNDS,
    stockPrices: { A: [100], B: [100], C: [100] },
    diceHistory: [],
    teams: {},       // { teamName: { cash, positions, options, trades, depotHistory, cashHistory, totalHistory } }
    gameEnded: false
  };
}

function createTeamState() {
  return {
    cash: 100000,
    margin: 0,         // blocked cash for short options
    positions: { A: 0, B: 0, C: 0 },
    options: [],
    trades: [],
    members: 1,        // number of connected members
    depotHistory: [0],
    cashHistory: [100000],
    totalHistory: [100000]
  };
}

function getCurrentPrices() {
  const prices = {};
  ['A', 'B', 'C'].forEach(s => {
    prices[s] = gameState.stockPrices[s][gameState.stockPrices[s].length - 1];
  });
  return prices;
}

function getTeamPortfolioTotal(team) {
  const prices = getCurrentPrices();
  let depot = 0;
  ['A', 'B', 'C'].forEach(s => {
    depot += team.positions[s] * prices[s];
  });
  return depot + team.cash;
}

function getLeaderboard() {
  return Object.entries(gameState.teams)
    .map(([name, team]) => ({
      name,
      value: getTeamPortfolioTotal(team),
      cash: team.cash,
      positions: { ...team.positions }
    }))
    .sort((a, b) => b.value - a.value);
}

function executeOptions(team, newPrices, settleRound) {
  let cashChange = 0;
  let positionChanges = { A: 0, B: 0, C: 0 };
  const executedOptions = [];

  team.options.forEach(opt => {
    const price = newPrices[opt.stock];
    const shares = opt.quantity * 100;
    let executed = false;
    let cashEffect = 0;
    let shareEffect = 0;
    let exerciseDescription = '';

    if (opt.type === 'call') {
      if (price >= opt.strike) {
        executed = true;
        if (opt.direction === 'buy') {
          // Long Call: Recht zu kaufen → zahle Strike, erhalte Aktien
          cashEffect = -(opt.strike * shares);
          shareEffect = shares;
          exerciseDescription = `Long Call ausgeübt: +${shares} ${opt.stock} @${opt.strike}`;
        } else {
          // Short Call: Pflicht zu liefern → liefere Aktien, erhalte Strike
          cashEffect = opt.strike * shares;
          shareEffect = -shares;
          exerciseDescription = `Short Call ausgeübt: -${shares} ${opt.stock} @${opt.strike}`;
        }
      }
    } else { // put
      if (price <= opt.strike) {
        executed = true;
        if (opt.direction === 'buy') {
          // Long Put: Recht zu verkaufen → liefere Aktien, erhalte Strike
          cashEffect = opt.strike * shares;
          shareEffect = -shares;
          exerciseDescription = `Long Put ausgeübt: -${shares} ${opt.stock} @${opt.strike}`;
        } else {
          // Short Put: Pflicht zu kaufen → zahle Strike, erhalte Aktien
          cashEffect = -(opt.strike * shares);
          shareEffect = shares;
          exerciseDescription = `Short Put ausgeübt: +${shares} ${opt.stock} @${opt.strike}`;
        }
      }
    }

    if (executed) {
      cashChange += cashEffect;
      positionChanges[opt.stock] += shareEffect;
    }

    // Calculate realized P&L including premium
    const premiumPaid = opt.premium * shares;
    const premiumSign = opt.direction === 'buy' ? -premiumPaid : premiumPaid;
    const realizedPL = executed ? (cashEffect + shareEffect * price + premiumSign) : premiumSign;

    // Store settlement result on the original trade
    const matchingTrade = team.trades.find(tr =>
      tr.type === 'option' && tr.stock === opt.stock && tr.strike === opt.strike &&
      tr.optionType === opt.type && tr.direction === opt.direction &&
      tr.round === opt.round && !tr.settled
    );
    if (matchingTrade) {
      matchingTrade.settled = true;
      matchingTrade.settleRound = settleRound;
      matchingTrade.settlePrice = price;
      matchingTrade.cashEffect = cashEffect;
      matchingTrade.shareEffect = shareEffect;
      matchingTrade.realizedPL = realizedPL;
      matchingTrade.executed = executed;
      matchingTrade.exerciseDescription = exerciseDescription;
    }

    // Add exercise as visible entry in trade history
    if (executed) {
      team.trades.push({
        round: settleRound,
        type: 'exercise',
        stock: opt.stock,
        optionType: opt.type,
        direction: opt.direction,
        quantity: shares,
        strike: opt.strike,
        price: price,
        cashEffect: cashEffect,
        shareEffect: shareEffect,
        total: Math.abs(cashEffect),
        description: exerciseDescription,
        timestamp: Date.now()
      });
    }

    executedOptions.push({ ...opt, cashEffect, shareEffect, executed, expired: !executed });
  });

  // Apply all changes
  team.cash += cashChange;
  ['A', 'B', 'C'].forEach(s => {
    team.positions[s] += positionChanges[s];
    // Positions can go negative (short stock from exercised short calls)
    // This is intentional — the team owes shares
  });

  // Release all margin since all options are settled
  team.margin = 0;
  team.options = []; // All options resolved
  return executedOptions;
}

// ====== WEBSOCKET ======
const clients = new Map(); // ws -> { type: 'admin'|'team', teamName?: string }

function broadcast(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function sendTo(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastGameUpdate() {
  const prices = getCurrentPrices();
  const leaderboard = getLeaderboard();

  // Send to admin
  wss.clients.forEach(client => {
    const info = clients.get(client);
    if (!info || client.readyState !== WebSocket.OPEN) return;

    if (info.type === 'admin') {
      sendTo(client, {
        type: 'game_update',
        state: {
          currentRound: gameState.currentRound,
          maxRounds: gameState.maxRounds,
          stockPrices: gameState.stockPrices,
          diceHistory: gameState.diceHistory,
          leaderboard,
          teams: Object.fromEntries(
            Object.entries(gameState.teams).map(([name, t]) => [name, {
              cash: t.cash,
              positions: t.positions,
              total: getTeamPortfolioTotal(t),
              trades: t.trades.length
            }])
          ),
          gameEnded: gameState.gameEnded
        }
      });
    } else if (info.type === 'team') {
      const team = gameState.teams[info.teamName];
      if (!team) return;
      sendTo(client, {
        type: 'game_update',
        state: {
          currentRound: gameState.currentRound,
          maxRounds: gameState.maxRounds,
          stockPrices: gameState.stockPrices,
          prices,
          team: {
            name: info.teamName,
            cash: team.cash,
            margin: team.margin || 0,
            positions: team.positions,
            options: team.options,
            trades: team.trades,
            depotHistory: team.depotHistory,
            cashHistory: team.cashHistory,
            totalHistory: team.totalHistory
          },
          leaderboard,
          gameEnded: gameState.gameEnded
        }
      });
    }
  });
}

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleMessage(ws, msg);
    } catch (e) {
      console.error('Message error:', e);
      sendTo(ws, { type: 'error', message: 'Ungültige Nachricht' });
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      console.log(`${info.type} disconnected${info.teamName ? ': ' + info.teamName : ''}`);
    }
    clients.delete(ws);
  });
});

function handleMessage(ws, msg) {
  switch (msg.action) {

    case 'join_team': {
      const name = (msg.teamName || '').trim();
      if (!name) {
        sendTo(ws, { type: 'error', message: 'Bitte Teamnamen eingeben!' });
        return;
      }
      // Create team if not exists
      if (!gameState.teams[name]) {
        gameState.teams[name] = createTeamState();
        gameState.teams[name].members = 0;
        console.log(`Team created: ${name}`);
      }
      // Check member limit
      const team = gameState.teams[name];
      // Count currently connected members for this team
      let connectedMembers = 0;
      clients.forEach((info) => {
        if (info.type === 'team' && info.teamName === name) connectedMembers++;
      });
      if (connectedMembers >= MAX_TEAM_MEMBERS) {
        sendTo(ws, { type: 'error', message: `Team "${name}" ist voll (max. ${MAX_TEAM_MEMBERS} Teilnehmer)!` });
        return;
      }
      clients.set(ws, { type: 'team', teamName: name });
      team.members = connectedMembers + 1;
      sendTo(ws, { type: 'joined', role: 'team', teamName: name });
      broadcastGameUpdate();
      break;
    }

    case 'join_admin': {
      if (msg.password !== ADMIN_PASSWORD) {
        sendTo(ws, { type: 'error', message: 'Falsches Passwort!' });
        return;
      }
      clients.set(ws, { type: 'admin' });
      sendTo(ws, { type: 'joined', role: 'admin' });
      broadcastGameUpdate();
      break;
    }

    case 'roll_dice': {
      const info = clients.get(ws);
      if (!info || info.type !== 'admin') {
        sendTo(ws, { type: 'error', message: 'Nur der Spielleiter darf würfeln!' });
        return;
      }
      if (gameState.currentRound >= gameState.maxRounds) {
        sendTo(ws, { type: 'error', message: 'Maximale Rundenzahl erreicht!' });
        return;
      }

      // Roll dice
      const dice = {
        A: Math.floor(Math.random() * 6) + 1,
        B: Math.floor(Math.random() * 6) + 1,
        C: Math.floor(Math.random() * 6) + 1
      };

      const newPrices = {};
      ['A', 'B', 'C'].forEach(s => {
        const lastPrice = gameState.stockPrices[s][gameState.stockPrices[s].length - 1];
        const change = DICE_MULTIPLIERS[dice[s] - 1] * STOCKS[s].beta;
        newPrices[s] = Math.max(1, lastPrice + change);
        gameState.stockPrices[s].push(newPrices[s]);
      });

      gameState.diceHistory.push(dice);
      gameState.currentRound++;

      // Execute options for all teams
      Object.entries(gameState.teams).forEach(([name, team]) => {
        if (team.options.length > 0) {
          executeOptions(team, newPrices, gameState.currentRound);
        }
        // Update portfolio history
        let depot = 0;
        ['A', 'B', 'C'].forEach(s => {
          depot += team.positions[s] * newPrices[s];
        });
        team.depotHistory.push(depot);
        team.cashHistory.push(team.cash);
        team.totalHistory.push(depot + team.cash);
      });

      console.log(`Round ${gameState.currentRound}: A=$${newPrices.A} B=$${newPrices.B} C=$${newPrices.C}`);

      // Broadcast dice animation first, then update
      broadcast({
        type: 'dice_rolled',
        dice,
        prices: newPrices,
        round: gameState.currentRound
      });

      setTimeout(() => broadcastGameUpdate(), 700);
      break;
    }

    case 'trade': {
      const info = clients.get(ws);
      if (!info || info.type !== 'team') return;
      const team = gameState.teams[info.teamName];
      if (!team) return;

      // Trading is allowed from round 0 up to (but not after) maxRounds
      if (gameState.gameEnded) {
        sendTo(ws, { type: 'error', message: 'Das Spiel ist beendet!' });
        return;
      }
      if (gameState.currentRound >= gameState.maxRounds) {
        sendTo(ws, { type: 'error', message: 'Alle Runden gespielt — kein Handel mehr möglich!' });
        return;
      }

      const prices = getCurrentPrices();

      if (msg.tradeType === 'stock') {
        if (!msg.quantity || msg.quantity < 100 || msg.quantity % 100 !== 0) {
          sendTo(ws, { type: 'error', message: 'Aktien müssen in 100er-Paketen gehandelt werden!' });
          return;
        }
        const price = prices[msg.stock];
        const cost = msg.quantity * price;

        if (msg.direction === 'buy') {
          if (cost > team.cash) {
            sendTo(ws, { type: 'error', message: 'Nicht genug Barmittel!' });
            return;
          }
          team.cash -= cost;
          team.positions[msg.stock] += msg.quantity;
        } else {
          if (team.positions[msg.stock] < msg.quantity) {
            sendTo(ws, { type: 'error', message: 'Nicht genug Aktien!' });
            return;
          }
          team.cash += cost;
          team.positions[msg.stock] -= msg.quantity;
        }

        team.trades.push({
          round: gameState.currentRound,
          type: 'stock',
          stock: msg.stock,
          direction: msg.direction,
          quantity: msg.quantity,
          price,
          total: cost,
          timestamp: Date.now()
        });

      } else if (msg.tradeType === 'option') {
        const premium = msg.premium * msg.quantity * 100;
        const availableCash = team.cash - team.margin;
        let marginRequired = 0;

        if (msg.direction === 'buy') {
          if (premium > availableCash) {
            sendTo(ws, { type: 'error', message: 'Nicht genug freie Barmittel!' });
            return;
          }
          team.cash -= premium;
        } else {
          // Selling (writing) options: require margin = strike × quantity × 100
          // Exception: Covered Call — if selling a call and team owns enough shares, margin = 0
          marginRequired = msg.strike * msg.quantity * 100;
          const sharesNeeded = msg.quantity * 100;
          if (msg.optionType === 'call' && team.positions[msg.stock] >= sharesNeeded) {
            marginRequired = 0; // Covered Call — no margin needed
          }
          if (marginRequired > availableCash + premium) {
            sendTo(ws, { type: 'error', message: `Nicht genug Kapital für Margin! Benötigt: $${marginRequired.toLocaleString()}` });
            return;
          }
          team.cash += premium;
          team.margin += marginRequired;
        }

        team.options.push({
          type: msg.optionType,
          stock: msg.stock,
          strike: msg.strike,
          quantity: msg.quantity,
          premium: msg.premium,
          direction: msg.direction,
          round: gameState.currentRound,
          marginBlocked: marginRequired
        });

        team.trades.push({
          round: gameState.currentRound,
          type: 'option',
          optionType: msg.optionType,
          stock: msg.stock,
          direction: msg.direction,
          quantity: msg.quantity,
          strike: msg.strike,
          price: msg.premium,
          total: premium,
          timestamp: Date.now()
        });
      }

      broadcastGameUpdate();
      break;
    }

    case 'end_game': {
      const info = clients.get(ws);
      if (!info || info.type !== 'admin') {
        sendTo(ws, { type: 'error', message: 'Nur der Spielleiter kann das Spiel beenden!' });
        return;
      }
      gameState.gameEnded = true;
      broadcast({ type: 'game_ended', leaderboard: getLeaderboard() });
      broadcastGameUpdate();
      break;
    }

    case 'reset_game': {
      const info = clients.get(ws);
      if (!info || info.type !== 'admin') {
        sendTo(ws, { type: 'error', message: 'Nur der Spielleiter kann das Spiel zurücksetzen!' });
        return;
      }
      gameState = createFreshState();
      // Disconnect all team clients
      clients.forEach((clientInfo, clientWs) => {
        if (clientInfo.type === 'team') {
          sendTo(clientWs, { type: 'reset' });
          clients.delete(clientWs);
        }
      });
      broadcastGameUpdate();
      console.log('Game reset');
      break;
    }

    default:
      sendTo(ws, { type: 'error', message: 'Unbekannte Aktion' });
  }
}

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`TraderIQ Game Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
