import fancyApiAdapter from '../adapter/FancyApiAdapter';
import type { AutomatedContractResult, AutomatedProposal } from '../types/automated-trading.types';

class AutomatedContractService {
    async buy(proposal: AutomatedProposal) {
        return fancyApiAdapter.buy(proposal);
    }

    waitForResult(contractId: string): Promise<AutomatedContractResult> {
        return fancyApiAdapter.monitorContract(contractId);
    }

    sell(contractId: string, price = 0) {
        return fancyApiAdapter.sell(contractId, price);
    }
}

export const automatedContractService = new AutomatedContractService();
export default automatedContractService;
