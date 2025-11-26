import { GoogleGenAI } from '@google/genai'
;
import { config } from '../config/environmentalVariables.js';
import { tickerExtractor } from '../prompts/tickerExtractor.js';
import { logger } from '../utils/Logger.js';

export type AiAssignmentType  = {
  label: string,
  name: string,
  confidence: number,
  explanation: string
 }

class AiAssignment {
 private GeminiAi: GoogleGenAI;

 constructor() {
  const {gemini_api_key} = config;
  
  if (!gemini_api_key) {
    throw new Error("Gemini API Key is not defined in environment variables");
  }

  this.GeminiAi = new GoogleGenAI({apiKey: gemini_api_key});
 }

async geminiAiAssignment(
  content: string, 
  retries: number = 3
): Promise<AiAssignmentType[]> {
  
  const prompt = tickerExtractor(content);

  for (let i = 0; i < retries; i++) {
    try {
      const response = await this.GeminiAi.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { temperature: 0.2 }
      });

      if (!response.text) {
        throw new Error("Empty response from Gemini API");
      }

      const cleaned = response.text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      const startIdx = cleaned.indexOf('[');
      const endIdx = cleaned.lastIndexOf(']');

      if (startIdx === -1 || endIdx === -1) {
        throw new Error("No JSON array in response");
      }

      const jsonStr = cleaned.substring(startIdx, endIdx + 1);
      const result: AiAssignmentType[] = JSON.parse(jsonStr);

      return result;

    } catch (error: any) {
      const isLastRetry = i === retries - 1;
      const shouldRetry = error.status === 503 || error.status === 429;

      if (isLastRetry || !shouldRetry) {
        throw new Error(`Gemini API error: ${error}`);
      }

      const delay = Math.pow(2, i + 1) * 1000;
      logger.info(`Retry ${i + 1}/${retries} in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error("Unreachable");
}
}



export default AiAssignment;