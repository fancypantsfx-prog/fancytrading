import React from 'react';

import { Popover } from '@deriv/components';
import { Link } from 'react-router-dom';
import { routes } from '@deriv/shared';
import { LegacyHelpCentreIcon } from '@deriv/quill-icons';
import { useTranslations } from '@deriv-com/translations';

export const HelpCentre = ({ showPopover }) => {
    const { localize } = useTranslations();
    return (
        <Link
            to={routes.help}
            id='dt_help_centre'
            aria-label={localize('Help centre')}
            className='footer__link'
        >
            {showPopover ? (
                <Popover
                    classNameBubble='help-centre__tooltip'
                    alignment='top'
                    message={localize('Help centre')}
                    zIndex={9999}
                >
                    <LegacyHelpCentreIcon className='footer__icon' iconSize='xs' />
                </Popover>
            ) : (
                <LegacyHelpCentreIcon className='footer__icon' iconSize='xs' />
            )}
        </Link>
    );
};
