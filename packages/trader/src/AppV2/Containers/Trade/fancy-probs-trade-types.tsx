import React from 'react';
import { localize } from '@deriv-com/translations';
import { signalTradeTypes } from 'AppV2/Components/AutoTrading/signal-rule';
import type { TContractType } from 'AppV2/Types/contract-type';

type TProps = {
    tradeTypes: TContractType[];
    value: string;
    onSelect: (value: string) => void | Promise<void>;
};

const FancyProbsTradeTypes = ({ tradeTypes, value, onSelect }: TProps) => {
    const available = tradeTypes.filter(type => Object.hasOwn(signalTradeTypes, type.value));
    const selected = available.find(type => type.value === value);
    const first = available[0]?.value;
    const [selectionError, setSelectionError] = React.useState(false);
    const select = React.useCallback(async (value: string) => {
        try {
            await onSelect(value);
            setSelectionError(false);
        } catch {
            setSelectionError(true);
        }
    }, [onSelect]);

    React.useEffect(() => {
        if (!selected && first) void select(first);
    }, [first, select, selected]);

    return (
        <label className='tick-insights__fancy-probs-contract'>
            {localize('Fancy Probs contract')}
            <select value={selected?.value ?? ''} onChange={event => void select(event.target.value)} disabled={!first}>
                {!selected && <option value=''>{localize(first ? 'Choose a contract' : 'No supported contracts')}</option>}
                {available.map(type => <option key={type.value} value={type.value}>{type.text}</option>)}
            </select>
            {selectionError && <span role='alert'>{localize('Could not select this contract. Choose an available contract or change markets.')}</span>}
        </label>
    );
};

export default FancyProbsTradeTypes;
