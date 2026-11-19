import React from 'react';
import { localize } from '@deriv-com/translations';
import { signalTradeTypes } from 'AppV2/Components/AutoTrading/signal-rule';
import type { TContractType } from 'AppV2/Types/contract-type';

type TProps = {
    tradeTypes: TContractType[];
    value: string;
    onSelect: (value: string) => void;
};

const FancyProbsTradeTypes = ({ tradeTypes, value, onSelect }: TProps) => {
    const available = tradeTypes.filter(type => Object.hasOwn(signalTradeTypes, type.value));
    const selected = available.find(type => type.value === value);
    const first = available[0]?.value;

    React.useEffect(() => {
        if (!selected && first) onSelect(first);
    }, [first, onSelect, selected]);

    return (
        <label className='tick-insights__fancy-probs-contract'>
            {localize('Fancy Probs contract')}
            <select value={selected?.value ?? ''} onChange={event => onSelect(event.target.value)} disabled={!first}>
                {!selected && <option value=''>{localize(first ? 'Choose a contract' : 'No supported contracts')}</option>}
                {available.map(type => <option key={type.value} value={type.value}>{type.text}</option>)}
            </select>
        </label>
    );
};

export default FancyProbsTradeTypes;
