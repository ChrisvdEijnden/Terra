interface AreaProps {
    hsvValue: number;
}

function Area({ hsvValue }: AreaProps) {
    const numberHSV = hsvValue;

    return numberHSV;
}

export default Area;