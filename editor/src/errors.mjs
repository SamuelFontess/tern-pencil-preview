export class EditorError extends Error {
	constructor(code, message, details) {
		super(message);
		this.code = code;
		this.details = details;
		this.name = 'EditorError';
	}
}
