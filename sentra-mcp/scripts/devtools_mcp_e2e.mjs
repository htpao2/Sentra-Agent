import SentraMcpSDK from '../src/sdk/index.js';

function pickObjective(argv) {
  const idx = argv.findIndex((a) => a === '--objective' || a === '-o');
  if (idx >= 0 && argv[idx + 1]) return String(argv[idx + 1]);
  return '帮我使用浏览器自动化打开bing搜索界面，看看明天上海天气';
}

function hasDevtoolsToolUse(events = []) {
  // External tool aiName is normalized by MCPCore as: ext__<serverId>__<toolName>
  // We recommend serverId: chrome-devtools
  return events.some((e) =>
    e && (e.type === 'args' || e.type === 'tool_result') &&
    typeof e.aiName === 'string' &&
    (e.aiName.startsWith('ext__chrome-devtools__') || e.aiName.includes('__chrome-devtools__'))
  );
}

async function main() {
  const objective = pickObjective(process.argv.slice(2));

  const sdk = new SentraMcpSDK();
  await sdk.init();

  const conversation = [
    {
      role: 'system',
      content:
        'You are a browser debugging & automation assistant. Prefer deterministic, small steps. Always use the available tools when you need live browser state.'
    },
    {
      role: 'user',
      content: objective
    }
  ];

  const events = [];

  for await (const ev of sdk.stream({
    objective: 'Complete the user objective using available tools.',
    conversation,
    context: {
      tenantId: 'devtools-e2e'
    }
  })) {
    events.push(ev);
    // Keep logs short but informative
    if (ev.type === 'judge') {
      console.log('[judge]', { need: ev.need, ok: ev.ok, operations: ev.operations });
    } else if (ev.type === 'plan') {
      console.log('[plan]', { steps: ev.plan?.steps?.map((s) => s.aiName) });
    } else if (ev.type === 'tool_result') {
      console.log('[tool_result]', { stepIndex: ev.stepIndex, aiName: ev.aiName, success: ev.result?.success, code: ev.result?.code });
    } else if (ev.type === 'summary') {
      console.log('[summary]', ev.summary);
      break;
    }
  }

  const usedDevtools = hasDevtoolsToolUse(events);
  if (!usedDevtools) {
    console.error('E2E FAIL: Did not observe any chrome-devtools external tool usage.');
    console.error('Hint: check mcp/servers.json has id "chrome-devtools" and the server is reachable, and Chrome remote debugging / autoConnect is configured correctly.');
    process.exitCode = 2;
  } else {
    console.log('E2E OK: Observed chrome-devtools MCP tool usage.');
  }
}

main().catch((e) => {
  console.error('E2E script failed:', e);
  process.exitCode = 1;
});
