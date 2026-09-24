/*
 * Live gateway check: replay the exact history that made the stuck session
 * unresumable, before and after the tool-call pairing repair.
 *
 * Expected: BROKEN → HTTP 400 "insufficient tool messages following tool_calls",
 *           REPAIRED → a normal assistant reply.
 */
import { loadConfig } from 'vs/workbench/contrib/agent/common/agentConfig';
import { LLMProviderFactory } from 'vs/workbench/services/agent/browser/llmProvider';
import 'vs/workbench/services/agent/browser/llmOpenai';
import { createMessage, MessageRole, IAgentMessage } from 'vs/workbench/services/agent/common/agentModels';

const resolved = loadConfig();
const cfg = resolved.agentConfig;
console.log(`provider=${cfg.provider} model=${cfg.model} base=${cfg.apiBase}`);
const provider = LLMProviderFactory.create(cfg);

const CALL_ID = 'call_00_RJdPWD1xw3GZ8C44Z5b99363';
const broken: IAgentMessage[] = [
	createMessage(MessageRole.System, 'You are a helpful assistant. Reply with one word.'),
	createMessage(MessageRole.User, 'build the project'),
	createMessage(MessageRole.Assistant, '', { toolCalls: [{ id: CALL_ID, name: 'run_terminal', arguments: { command: 'make' } }] }),
	createMessage(MessageRole.User, '继续'),
];
const repaired: IAgentMessage[] = [
	...broken.slice(0, 3),
	createMessage(MessageRole.Tool, '[not executed] the tool call was never answered (task interrupted or cancelled)', { toolCallId: CALL_ID }),
	broken[3],
];

async function attempt(label: string, messages: IAgentMessage[]): Promise<void> {
	try {
		const reply = await provider.complete(messages, undefined, 0);
		console.log(`\n${label}: OK — assistant replied ${JSON.stringify((reply.content || '').slice(0, 60))}`);
	} catch (err) {
		console.log(`\n${label}: FAILED — ${(err as Error).message.slice(0, 300)}`);
	}
}

await attempt('BROKEN  (dangling tool_calls)', broken);
await attempt('REPAIRED (synthetic tool answer)', repaired);
