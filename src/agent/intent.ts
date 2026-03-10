export const processAgathaIntention = (thought: string) => {
    // Si Agatha detecta una oportunidad o una pregunta
    if (thought.toLowerCase().includes("analiza")) {
        return "EJECUTANDO_ANALISIS";
    }
    return "ESPERANDO_INSTRUCCIONES";
};