export {
    automatedTradingEngine,
    AutomatedTradingEngine,
} from './engine/automated-trading.engine';

export type {
    AutomationActivity,
    AutomationState,
} from './engine/automated-trading.engine';

export {
    fancyApiAdapter,
} from './adapter/FancyApiAdapter';

export {
    fancyTicksService,
} from './adapter/FancyTicksService';

export {
    automatedContractService,
} from './services/automated-contract.service';

export {
    automatedProposalService,
} from './services/automated-proposal.service';

export {
    automatedTicksService,
} from './services/automated-ticks.service';

export {
    automatedCapabilitiesService,
} from './services/automated-capabilities.service';

export {
    getAutomatedCapabilities,
} from './capabilities/automated-contract-capabilities';

export {
    OverUnderStrategy,
    getLastDigit,
} from './strategies/over-under.strategy';

export {
    EvenOddStrategy,
} from './strategies/even-odd.strategy';

export {
    MatchesDiffersStrategy,
} from './strategies/matches-differs.strategy';

export {
    createAutomatedStrategy,
    getImplementedStrategies,
    isStrategyImplemented,
} from './strategies/strategy-factory';

export type {
    AutomatedContractResult,
    AutomatedProposal,
    AutomatedSignal,
    AutomatedTick,
    AutomatedTradeConfig,
    AutomatedTradeResult,
    AutomatedStrategyType,
    AutomatedContractType,
    AutomatedDirection,
    ContractDirection,
    AutomatedContractCapability,
    AutomatedSymbolCapabilities,
    ManualTradeSelection,
    ManualAutomationConfig,
} from './types/automated-trading.types';