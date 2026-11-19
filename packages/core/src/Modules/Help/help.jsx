import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getPlatformLogo, redirectToSignUp, routes } from '@deriv/shared';
import { observer, useStore } from '@deriv/stores';
import { localize } from '@deriv-com/translations';
import './help.scss';

const getSteps = () => [
    {
        title: localize('Open your demo account'),
        text: localize('Log in to Deriv, switch to your demo account, then open FancyTrading from the trading screen.'),
    },
    {
        title: localize('Find a contract'),
        text: localize('Open Fancy Strategy Finder. Pick a contract group and duration in ticks. Use Get live quote to review the stake and current payout before confirming.'),
    },
    {
        title: localize('Compare setups'),
        text: localize('Choose Add to Compare on a result. In Compare, select the same tick duration and history window for each setup so you can compare the historical hit rates side by side.'),
    },
    {
        title: localize('Try Fancy Probs'),
        text: localize('Choose Fancy Probs in the FancyTrading menu. Select an available Rise / Fall or Digits contract on the chart and configure a rule. Review your stake and stop conditions before starting a run.'),
    },
];

const Help = observer(() => {
    const [step, setStep] = React.useState(0);
    const steps = getSteps();
    const { client } = useStore();
    const { hash } = useLocation();
    React.useEffect(() => {
        if (hash === '#tutorial' || hash === '#questions') {
            document.getElementById(hash.slice(1))?.scrollIntoView?.();
        }
    }, [hash]);

    return (
        <main className='fancy-help'>
            <header className='fancy-help__hero'>
                <img src={`/${getPlatformLogo()}`} alt='' width={56} height={56} />
                <h1>{localize('FancyTrading Help')}</h1>
                <p>{localize('Learn to find contracts, compare setups, and practise on your Deriv demo account.')}</p>
                <nav aria-label={localize('Help topics')}>
                    <a href='#tutorial'>{localize('Start tutorial')}</a>
                    <a href='#questions'>{localize('Common questions')}</a>
                    <Link to={routes.index}>{localize('Open trading')}</Link>
                </nav>
            </header>
            <section id='tutorial' className='fancy-help__panel' aria-labelledby='tutorial-title'>
                <h2 id='tutorial-title'>{localize('Trading tutorial')}</h2>
                <div aria-live='polite' aria-atomic='true'>
                    <p className='fancy-help__progress'>{localize('Step {{step}} of {{total}}', {
                        step: String(step + 1), total: String(steps.length),
                    })}</p>
                    <h3>{steps[step].title}</h3>
                    <p>{steps[step].text}</p>
                </div>
                <div className='fancy-help__actions'>
                    {step > 0 && <button type='button' onClick={() => setStep(step - 1)}>{localize('Back')}</button>}
                    {step < steps.length - 1 ? (
                        <button type='button' onClick={() => setStep(step + 1)}>{localize('Next step')}</button>
                    ) : (
                        <>
                            <button type='button' onClick={() => setStep(0)}>{localize('Restart tutorial')}</button>
                            <Link to={routes.index}>{localize('Open trading')}</Link>
                        </>
                    )}
                    {!client.is_logged_in && step === 0 && (
                        <button type='button' onClick={() => void redirectToSignUp()}>{localize('Create a Deriv account')}</button>
                    )}
                </div>
            </section>
            <section id='questions' className='fancy-help__panel'>
                <h2>{localize('Common questions')}</h2>
                <details>
                    <summary>{localize('Why is Fancy Strategy Finder empty?')}</summary>
                    <p>{localize('The finder refreshes automatically and shows the latest cached sample for each result. Try a different duration or contract group if the current selection is empty.')}</p>
                </details>
                <details>
                    <summary>{localize('Why did the payout change during trade review?')}</summary>
                    <p>{localize('Deriv quotes the payout for your account and stake when you select a contract. If the price changes before purchase, review the updated payout before confirming again.')}</p>
                </details>
                <details>
                    <summary>{localize('Where are Accumulators and Multipliers?')}</summary>
                    <p>{localize('Choose Back to normal trading to use the full contract selector for your market. Fancy Probs has its own selector for Rise / Fall and Digits.')}</p>
                </details>
            </section>
        </main>
    );
});

export default Help;
