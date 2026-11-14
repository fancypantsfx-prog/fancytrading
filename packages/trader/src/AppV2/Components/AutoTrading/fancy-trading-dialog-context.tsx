import React from 'react';

type TFancyTradingDialog = {
    open: boolean;
    setOpen: (open: boolean) => void;
    signalOpen: boolean;
    setSignalOpen: (open: boolean) => void;
};

export const FancyTradingDialogContext = React.createContext<TFancyTradingDialog | null>(null);

export const FancyTradingDialogProvider = ({
    children,
    enabled = true,
}: React.PropsWithChildren<{ enabled?: boolean }>) => {
    const [open, setOpen] = React.useState(false);
    const [signalOpen, setSignalOpen] = React.useState(false);

    React.useEffect(() => {
        if (!enabled) {
            setOpen(false);
            setSignalOpen(false);
        }
    }, [enabled]);

    const value = React.useMemo(
        () => ({ open: enabled && open, setOpen, signalOpen: enabled && signalOpen, setSignalOpen }),
        [enabled, open, signalOpen]
    );

    return <FancyTradingDialogContext.Provider value={value}>{children}</FancyTradingDialogContext.Provider>;
};
