require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const SYSTEM_PROMPT = require('./systemPrompt');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function test() {
  console.log('Testing Anthropic API...');
  console.log('API Key starts with:', process.env.ANTHROPIC_API_KEY?.substring(0, 20));

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'שלום' }]
    });
    console.log('SUCCESS! Bot reply:', response.content[0].text);
  } catch (error) {
    console.error('ERROR:', error.message);
  }
}

test();
