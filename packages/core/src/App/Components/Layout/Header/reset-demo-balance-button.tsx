import React from 'react';

import { Button } from '@deriv/components';
import { observer, useStore } from '@deriv/stores';
import { useTranslations } from '@deriv-com/translations';

const ResetDemoBalanceButton = observer(() => {
    const { client } = useStore();
    const { localize } = useTranslations();

    if (!client.is_logged_in || !client.is_virtual) return null;

    return (
        <div className='reset-demo-balance'>
            <Button
                className='reset-demo-balance__button'
                type='button'
                secondary
                small
                is_disabled={client.is_resetting_virtual_balance}
                onClick={client.resetVirtualBalance}
                text={client.is_resetting_virtual_balance ? localize('Resetting…') : localize('Reset balance')}
            />
            {client.virtual_balance_reset_failed && (
                <div className='reset-demo-balance__error' role='alert'>
                    {localize('Could not reset the demo balance. Please try again.')}
                </div>
            )}
        </div>
    );
});

export default ResetDemoBalanceButton;
