/*---------------------------------------------------------------------------------------------
 *  Agent Chat Panel - Message list + input box + streaming render
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { IAgentMessage, AgentMode, MessageRole } from 'vs/workbench/services/agent/common/agentModels';
import { IAgentService } from 'vs/workbench/services/agent/common/agentService';

export class AgentChatPanel extends Disposable {
	private readonly _container: HTMLElement;
	private readonly _messageList: HTMLElement;
	private readonly _inputArea: HTMLElement;
	private readonly _inputBox: HTMLTextAreaElement;
	private readonly _sendButton: HTMLButtonElement;
	private readonly _modeSelector: HTMLSelectElement;
	private readonly _statusBar: HTMLElement;

	private _streamingElement: HTMLElement | undefined;

	constructor(
		parent: HTMLElement,
		private readonly _agentService: IAgentService,
	) {
		super();

		this._container = document.createElement('div');
		this._container.className = 'agent-chat-container';
		parent.appendChild(this._container);

		// --- Header with mode selector ---
		const header = document.createElement('div');
		header.className = 'agent-chat-header';

		this._modeSelector = document.createElement('select');
		this._modeSelector.className = 'agent-mode-selector';
		this._modeSelector.innerHTML = `
			<option value="agent">Agent</option>
			<option value="ask">Ask</option>
			<option value="plan">Plan</option>
		`;
		header.appendChild(this._modeSelector);

		this._statusBar = document.createElement('span');
		this._statusBar.className = 'agent-status';
		this._statusBar.textContent = 'Ready';
		header.appendChild(this._statusBar);

		this._container.appendChild(header);

		// --- Message list ---
		this._messageList = document.createElement('div');
		this._messageList.className = 'agent-message-list';
		this._container.appendChild(this._messageList);

		// --- Input area ---
		this._inputArea = document.createElement('div');
		this._inputArea.className = 'agent-input-area';

		this._inputBox = document.createElement('textarea');
		this._inputBox.className = 'agent-input-box';
		this._inputBox.placeholder = 'Ask the agent to do something...';
		this._inputBox.rows = 3;
		this._inputArea.appendChild(this._inputBox);

		const buttonRow = document.createElement('div');
		buttonRow.className = 'agent-button-row';

		this._sendButton = document.createElement('button');
		this._sendButton.className = 'agent-send-button';
		this._sendButton.textContent = 'Send';
		buttonRow.appendChild(this._sendButton);

		this._inputArea.appendChild(buttonRow);
		this._container.appendChild(this._inputArea);

		this._setupEventListeners();
	}

	layout(height: number, width: number): void {
		this._container.style.height = `${height}px`;
		this._container.style.width = `${width}px`;
	}

	private _setupEventListeners(): void {
		// Send on button click
		this._sendButton.addEventListener('click', () => this._handleSend());

		// Send on Enter (Shift+Enter for newline)
		this._inputBox.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._handleSend();
			}
		});

		// Mode selector
		this._modeSelector.addEventListener('change', () => {
			const mode = this._modeSelector.value as AgentMode;
			this._agentService.switchMode(mode);
		});

		// Subscribe to agent events
		this._register(this._agentService.onDidReceiveMessage(msg => {
			this._appendMessage(msg);
		}));

		this._register(this._agentService.onDidStartTask(() => {
			this._setStatus('Working...');
			this._sendButton.disabled = true;
		}));

		this._register(this._agentService.onDidComplete(() => {
			this._setStatus('Ready');
			this._sendButton.disabled = false;
			this._streamingElement = undefined;
		}));

		this._register(this._agentService.onDidError(err => {
			this._setStatus('Error');
			this._sendButton.disabled = false;
			this._appendErrorMessage(err.message);
		}));

		this._register(this._agentService.onDidChangeMode(mode => {
			this._modeSelector.value = mode;
		}));

		this._register(this._agentService.onDidStreamToken(token => {
			this._appendStreamToken(token);
		}));
	}

	private async _handleSend(): Promise<void> {
		const text = this._inputBox.value.trim();
		if (!text) { return; }

		this._inputBox.value = '';
		await this._agentService.sendMessage(text);
	}

	private _appendMessage(msg: IAgentMessage): void {
		const el = document.createElement('div');
		el.className = `agent-message agent-message-${msg.role}`;

		const roleLabel = document.createElement('div');
		roleLabel.className = 'agent-message-role';
		roleLabel.textContent = this._getRoleLabel(msg.role);
		el.appendChild(roleLabel);

		const content = document.createElement('div');
		content.className = 'agent-message-content';

		if (msg.toolCalls && msg.toolCalls.length > 0) {
			for (const tc of msg.toolCalls) {
				const toolBlock = document.createElement('div');
				toolBlock.className = 'agent-tool-call';

				const toolHeader = document.createElement('div');
				toolHeader.className = 'agent-tool-call-header';
				toolHeader.textContent = `Tool: ${tc.name}`;

				const toolArgs = document.createElement('pre');
				toolArgs.className = 'agent-tool-call-args';
				toolArgs.textContent = JSON.stringify(tc.arguments, null, 2);

				const toggle = document.createElement('button');
				toggle.className = 'agent-tool-toggle';
				toggle.textContent = 'Show args';
				toggle.addEventListener('click', () => {
					toolArgs.style.display = toolArgs.style.display === 'none' ? 'block' : 'none';
					toggle.textContent = toolArgs.style.display === 'none' ? 'Show args' : 'Hide args';
				});

				toolArgs.style.display = 'none';
				toolBlock.appendChild(toolHeader);
				toolBlock.appendChild(toggle);
				toolBlock.appendChild(toolArgs);
				content.appendChild(toolBlock);
			}
		}

		if (msg.content) {
			const textBlock = document.createElement('div');
			textBlock.className = 'agent-message-text';
			textBlock.textContent = msg.content;
			content.appendChild(textBlock);
		}

		el.appendChild(content);
		this._messageList.appendChild(el);
		this._scrollToBottom();
	}

	private _appendStreamToken(token: string): void {
		if (!this._streamingElement) {
			this._streamingElement = document.createElement('div');
			this._streamingElement.className = 'agent-message agent-message-assistant agent-streaming';

			const roleLabel = document.createElement('div');
			roleLabel.className = 'agent-message-role';
			roleLabel.textContent = 'Agent';
			this._streamingElement.appendChild(roleLabel);

			const content = document.createElement('div');
			content.className = 'agent-message-content';
			this._streamingElement.appendChild(content);

			this._messageList.appendChild(this._streamingElement);
		}

		const contentEl = this._streamingElement.querySelector('.agent-message-content');
		if (contentEl) {
			contentEl.textContent += token;
		}

		this._scrollToBottom();
	}

	private _appendErrorMessage(error: string): void {
		const el = document.createElement('div');
		el.className = 'agent-message agent-message-error';
		el.textContent = `Error: ${error}`;
		this._messageList.appendChild(el);
		this._scrollToBottom();
	}

	private _setStatus(text: string): void {
		this._statusBar.textContent = text;
	}

	private _scrollToBottom(): void {
		this._messageList.scrollTop = this._messageList.scrollHeight;
	}

	private _getRoleLabel(role: MessageRole): string {
		switch (role) {
			case MessageRole.User: return 'You';
			case MessageRole.Assistant: return 'Agent';
			case MessageRole.Tool: return 'Tool Result';
			case MessageRole.System: return 'System';
		}
	}

	override dispose(): void {
		this._container.remove();
		super.dispose();
	}
}
