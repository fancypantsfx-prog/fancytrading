import React from 'react';
import { localize } from '@deriv-com/translations';

const MenuHelp = ({ label, description }: { label: string; description: string }) => {
    const [expanded, setExpanded] = React.useState(false);
    const id = React.useId();

    return (
        <span className='tick-insights__menu-help'>
            <button
                type='button'
                aria-label={localize('Help for {{menu}}', { menu: label })}
                aria-expanded={expanded}
                aria-controls={id}
                onClick={() => setExpanded(value => !value)}
            >
                ?
            </button>
            <span id={id} hidden={!expanded}>
                {description}
            </span>
        </span>
    );
};

export default MenuHelp;
