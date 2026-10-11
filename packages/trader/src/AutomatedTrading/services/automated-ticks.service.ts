import fancyApiAdapter from '../adapter/FancyApiAdapter';
import fancyTicksService from '../adapter/FancyTicksService';
import type { AutomatedTick } from '../types/automated-trading.types';

class AutomatedTicksService {
    async getHistory(symbol: string, count = 1000): Promise<AutomatedTick[]> {
        const activeSymbol = await fancyApiAdapter.getActiveSymbol(symbol);

        if (!activeSymbol) {
            throw new Error(`Symbol ${symbol} is not an active Deriv symbol`);
        }

        const result = await fancyTicksService.request({
            symbol,
            count,
            pipSize: activeSymbol.pipSize,
        });

        return result as AutomatedTick[];
    }

    async start(
        symbol: string,
        onTick: (tick: AutomatedTick) => void
    ): Promise<string> {
        const activeSymbol = await fancyApiAdapter.getActiveSymbol(symbol);

        if (!activeSymbol) {
            throw new Error(`Symbol ${symbol} is not an active Deriv symbol`);
        }

        return fancyTicksService.monitor({
            symbol,
            pipSize: activeSymbol.pipSize,
            callback: onTick,
        });
    }

    stop(subscriptionKey: string): void {
        fancyTicksService.stopMonitor(subscriptionKey);
    }

    getLastTick(symbol: string) {
        return fancyTicksService.getLastTick(symbol);
    }
}

export const automatedTicksService = new AutomatedTicksService();

export default automatedTicksService;